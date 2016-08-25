namespace ts.pxt {
    export const assert = Util.assert;
    export const oops = Util.oops;
    export type StringMap<T> = Util.Map<T>;
    export import U = ts.pxt.Util;

    export const BINARY_JS = "binary.js";
    export const BINARY_HEX = "binary.hex";
    export const BINARY_ASM = "binary.asm";

    let EK = ir.EK;
    export const SK = SyntaxKind;

    export const numReservedGlobals = 1;

    export function stringKind(n: Node) {
        if (!n) return "<null>"
        return (<any>ts).SyntaxKind[n.kind]
    }

    interface NodeWithCache extends Expression {
        cachedIR: ir.Expr;
        needsIRCache: boolean;
    }

    function inspect(n: Node) {
        console.log(stringKind(n))
    }

    // next free error 9254
    function userError(code: number, msg: string, secondary = false): Error {
        let e = new Error(msg);
        (<any>e).ksEmitterUserError = true;
        (<any>e).ksErrorCode = code;
        if (secondary && inCatchErrors) {
            if (!lastSecondaryError) {
                lastSecondaryError = msg
                lastSecondaryErrorCode = code
            }
            return e
        }
        debugger;
        throw e;
    }

    function isRefType(t: Type) {
        checkType(t);
        if (t.flags & TypeFlags.ThisType)
            return true
        if (t.flags & TypeFlags.Null)
            return false
        if (t.flags & TypeFlags.Undefined)
            return false
        if (t.flags & TypeFlags.TypeParameter) {
            let b = lookupTypeParameter(t)
            if (b) return b.isRef
            U.oops("unbound type parameter: " + checker.typeToString(t))
        }
        return !(t.flags & (TypeFlags.Number | TypeFlags.Boolean | TypeFlags.Enum))
    }

    function isRefDecl(def: Declaration) {
        if ((<any>def).isThisParameter)
            return true;
        //let tp = checker.getDeclaredTypeOfSymbol(def.symbol)
        let tp = typeOf(def)
        return isRefType(tp)
    }

    export function setCellProps(l: ir.Cell) {
        l._isRef = isRefDecl(l.def)
        l._isLocal = isLocalVar(l.def) || isParameter(l.def)
        l._isGlobal = isGlobalVar(l.def)
        if (!l.isRef() && typeOf(l.def).flags & TypeFlags.Void) {
            oops("void-typed variable, " + l.toString())
        }
    }

    function isStringLiteral(node: Node) {
        switch (node.kind) {
            case SK.TemplateHead:
            case SK.TemplateMiddle:
            case SK.TemplateTail:
            case SK.StringLiteral:
            case SK.NoSubstitutionTemplateLiteral:
                return true;
            default: return false;
        }
    }

    function isEmptyStringLiteral(e: Expression | TemplateLiteralFragment) {
        return isStringLiteral(e) && (e as LiteralExpression).text == ""
    }

    function isStatic(node: Declaration) {
        return node.modifiers && node.modifiers.some(m => m.kind == SK.StaticKeyword)
    }

    function isClassFunction(node: Node) {
        if (!node) return false;
        switch (node.kind) {
            case SK.MethodDeclaration:
            case SK.Constructor:
            case SK.GetAccessor:
            case SK.SetAccessor:
                return true
            default:
                return false
        }
    }

    function getEnclosingMethod(node: Node): MethodDeclaration {
        if (!node) return null;
        if (isClassFunction(node))
            return <MethodDeclaration>node;
        return getEnclosingMethod(node.parent)
    }

    function isInAnyWayGeneric(node: FunctionLikeDeclaration) {
        return isGenericFunction(node) || hasGenericParent(node)
    }

    function hasGenericParent(node: Node): boolean {
        let par = getEnclosingFunction(node)
        if (par)
            return isGenericFunction(par) || hasGenericParent(par)
        return false
    }

    function getEnclosingFunction(node0: Node) {
        let node = node0
        while (true) {
            node = node.parent
            if (!node)
                userError(9229, lf("cannot determine parent of {0}", stringKind(node0)))
            switch (node.kind) {
                case SK.MethodDeclaration:
                case SK.Constructor:
                case SK.GetAccessor:
                case SK.SetAccessor:
                case SK.FunctionDeclaration:
                case SK.ArrowFunction:
                case SK.FunctionExpression:
                    return <FunctionLikeDeclaration>node
                case SK.SourceFile:
                    return null
            }
        }
    }

    function isGlobalVar(d: Declaration) {
        if (!d) return false
        return (d.kind == SK.VariableDeclaration && !getEnclosingFunction(d)) ||
            (d.kind == SK.PropertyDeclaration && isStatic(d))
    }

    function isLocalVar(d: Declaration) {
        return d.kind == SK.VariableDeclaration && !isGlobalVar(d);
    }

    function isParameter(d: Declaration) {
        return d.kind == SK.Parameter
    }

    function isTopLevelFunctionDecl(decl: Declaration) {
        return (decl.kind == SK.FunctionDeclaration && !getEnclosingFunction(decl)) ||
            isClassFunction(decl)
    }

    function isSideEffectfulInitializer(init: Expression) {
        if (!init) return false;
        switch (init.kind) {
            case SK.NullKeyword:
            case SK.NumericLiteral:
            case SK.StringLiteral:
            case SK.TrueKeyword:
            case SK.FalseKeyword:
                return false;
            default:
                return true;
        }
    }

    export interface CommentAttrs {
        debug?: boolean; // requires ?dbg=1
        shim?: string;
        enumval?: string;
        helper?: string;
        help?: string;
        async?: boolean;
        promise?: boolean;
        hidden?: boolean;
        callingConvention: ir.CallingConvention;
        block?: string;
        blockId?: string;
        blockGap?: string;
        blockExternalInputs?: boolean;
        blockImportId?: string;
        blockBuiltin?: boolean;
        blockNamespace?: string;
        color?: string;
        icon?: string;
        imageLiteral?: number;
        weight?: number;
        parts?: string;
        trackArgs?: number[];

        // on interfaces
        indexerGet?: string;
        indexerSet?: string;

        _name?: string;
        jsDoc?: string;
        paramHelp?: Util.Map<string>;
        // foo.defl=12 -> paramDefl: { foo: "12" }
        paramDefl: Util.Map<string>;
    }

    const numberAttributes = ["weight", "imageLiteral"]

    export interface CallInfo {
        decl: Declaration;
        qName: string;
        attrs: CommentAttrs;
        args: Expression[];
    }

    interface ClassInfo {
        reffields: PropertyDeclaration[];
        primitivefields: PropertyDeclaration[];
        allfields: PropertyDeclaration[];
        attrs: CommentAttrs;
    }

    let lf = assembler.lf;
    let checker: TypeChecker;
    let lastSecondaryError: string
    let lastSecondaryErrorCode = 0
    let inCatchErrors = 0

    export interface TypeBinding {
        tp: Type;
        isRef: boolean;
    }
    let typeBindings: TypeBinding[] = []

    export function getComments(node: Node) {
        let src = getSourceFileOfNode(node)
        let doc = getLeadingCommentRangesOfNodeFromText(node, src.text)
        if (!doc) return "";
        let cmt = doc.map(r => src.text.slice(r.pos, r.end)).join("\n")
        return cmt;
    }

    export function parseCommentString(cmt: string): CommentAttrs {
        let res: CommentAttrs = { paramDefl: {}, callingConvention: ir.CallingConvention.Plain }
        let didSomething = true
        while (didSomething) {
            didSomething = false
            cmt = cmt.replace(/\/\/%[ \t]*([\w\.]+)(=(("[^"\n]+")|'([^'\n]+)'|([^\s]*)))?/,
                (f: string, n: string, d0: string, d1: string,
                    v0: string, v1: string, v2: string) => {
                    let v = v0 ? JSON.parse(v0) : (d0 ? (v0 || v1 || v2) : "true");
                    if (U.endsWith(n, ".defl")) {
                        res.paramDefl[n.slice(0, n.length - 5)] = v
                    } else {
                        (<any>res)[n] = v;
                    }
                    didSomething = true
                    return "//% "
                })
        }

        for (let n of numberAttributes) {
            if (typeof (res as any)[n] == "string")
                (res as any)[n] = parseInt((res as any)[n])
        }

        if (res.trackArgs) {
            res.trackArgs = ((res.trackArgs as any) as string).split(/[ ,]+/).map(s => parseInt(s) || 0)
        }

        res.paramHelp = {}
        res.jsDoc = ""
        cmt = cmt.replace(/\/\*\*([^]*?)\*\//g, (full: string, doccmt: string) => {
            doccmt = doccmt.replace(/\n\s*(\*\s*)?/g, "\n")
            doccmt = doccmt.replace(/^\s*@param\s+(\w+)\s+(.*)$/mg, (full: string, name: string, desc: string) => {
                res.paramHelp[name] = desc
                return ""
            })
            res.jsDoc += doccmt
            return ""
        })

        res.jsDoc = res.jsDoc.trim()

        if (res.async)
            res.callingConvention = ir.CallingConvention.Async
        if (res.promise)
            res.callingConvention = ir.CallingConvention.Promise

        return res
    }

    export function parseCommentsOnSymbol(symbol: Symbol): CommentAttrs {
        let cmts = ""
        for (let decl of symbol.declarations) {
            cmts += getComments(decl)
        }
        return parseCommentString(cmts)
    }

    export function parseComments(node: Node): CommentAttrs {
        if (!node || (node as any).isRootFunction) return parseCommentString("")
        let res = parseCommentString(getComments(node))
        res._name = getName(node)
        return res
    }

    export function getName(node: Node & { name?: any; }) {
        if (!node.name || node.name.kind != SK.Identifier)
            return "???"
        return (node.name as Identifier).text
    }

    function isArrayType(t: Type) {
        return (t.flags & TypeFlags.Reference) && t.symbol.name == "Array"
    }

    function isInterfaceType(t: Type) {
        return t.flags & TypeFlags.Interface;
    }

    function genericRoot(t: Type) {
        if (t.flags & TypeFlags.Reference) {
            let r = t as TypeReference
            if (r.typeArguments && r.typeArguments.length)
                return r.target
        }
        return null
    }

    function isClassType(t: Type) {
        // check if we like the class?
        return !!(t.flags & TypeFlags.Class) || !!(t.flags & TypeFlags.ThisType)
    }

    function isPossiblyGenericClassType(t: Type) {
        let g = genericRoot(t)
        if (g) return isClassType(g)
        return isClassType(t)
    }

    function arrayElementType(t: Type): Type {
        if (isArrayType(t))
            return checkType((<TypeReference>t).typeArguments[0])
        return null;
    }

    function deconstructFunctionType(t: Type) {
        let sigs = checker.getSignaturesOfType(t, SignatureKind.Call)
        if (sigs && sigs.length == 1)
            return sigs[0]
        return null
    }

    function lookupTypeParameter(t: Type) {
        if (!(t.flags & TypeFlags.TypeParameter)) return null
        for (let i = typeBindings.length - 1; i >= 0; --i)
            if (typeBindings[i].tp == t) return typeBindings[i]
        return null
    }

    function checkType(t: Type) {
        let ok = TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean |
            TypeFlags.Void | TypeFlags.Enum | TypeFlags.Null
        if ((t.flags & ok) == 0) {
            if (isArrayType(t)) return t;
            if (isClassType(t)) return t;
            if (isInterfaceType(t)) return t;
            if (deconstructFunctionType(t)) return t;
            if (lookupTypeParameter(t)) return t;

            let g = genericRoot(t)
            if (g) {
                checkType(g);
                (t as TypeReference).typeArguments.forEach(checkType)
                return t
            }

            userError(9201, lf("unsupported type: {0} 0x{1}", checker.typeToString(t), t.flags.toString(16)), true)
        }
        return t
    }

    function typeOf(node: Node) {
        let r: Type;
        if (isExpression(node))
            r = checker.getContextualType(<Expression>node)
        if (!r) {
            try {
                r = checker.getTypeAtLocation(node);
            }
            catch (e) {
                userError(9203, lf("Unknown type for expression"))
            }
        }
        return checkType(r)
    }

    function isGenericFunction(fun: FunctionLikeDeclaration) {
        return getTypeParameters(fun).length > 0
    }

    function getTypeParameters(fun: FunctionLikeDeclaration) {
        // TODO add check for methods of generic classes
        if (fun.typeParameters && fun.typeParameters.length)
            return fun.typeParameters
        if (isClassFunction(fun) || fun.kind == SK.MethodSignature) {
            if (fun.parent.kind == SK.ClassDeclaration || fun.parent.kind == SK.InterfaceDeclaration) {
                let tp: TypeParameterDeclaration[] = (fun.parent as ClassLikeDeclaration).typeParameters
                return tp || []
            }
        }
        return []
    }

    function funcHasReturn(fun: FunctionLikeDeclaration) {
        let sig = checker.getSignatureFromDeclaration(fun)
        let rettp = checker.getReturnTypeOfSignature(sig)
        return !(rettp.flags & TypeFlags.Void)
    }

    export function getDeclName(node: Declaration) {
        let text = node && node.name ? (<Identifier>node.name).text : null
        if (!text && node.kind == SK.Constructor)
            text = "constructor"
        if (node && node.parent && node.parent.kind == SK.ClassDeclaration)
            text = (<ClassDeclaration>node.parent).name.text + "." + text
        text = text || "inline"
        return text;
    }

    function getTypeBindings(t: Type) {
        let g = genericRoot(t)
        if (!g) return []
        return getTypeBindingsCore(g.typeParameters, (t as TypeReference).typeArguments)
    }

    function getTypeBindingsCore(typeParameters: TypeParameter[], args: Type[]): TypeBinding[] {
        U.assert(typeParameters.length == args.length)
        return typeParameters.map((tp, i) => ({ tp: tp, isRef: isRefType(args[i]) }))
    }

    function getEnclosingTypeBindings(func: Declaration) {
        let bindings: TypeBinding[] = []
        addEnclosingTypeBindings(bindings, func)
        return bindings
    }

    function addEnclosingTypeBindings(bindings: TypeBinding[], func: Declaration) {
        for (let outer = getEnclosingFunction(func); outer; outer = getEnclosingFunction(outer)) {
            for (let tp of getTypeParameters(outer)) {
                let res = checker.getTypeAtLocation(tp)
                let binding = typeBindings.filter(b => b.tp == res)[0]
                if (!binding) {
                    U.oops("cannot find binding for: " + checker.typeToString(res))
                }
                bindings.push(binding)
            }
        }
    }

    function refMask(types: TypeBinding[]) {
        if (!types || !types.length) return ""
        return "_" + types.map(t => t.isRef ? "R" : "P").join("")
    }

    export function getFunctionLabel(node: FunctionLikeDeclaration, bindings: TypeBinding[]) {
        let text = getDeclName(node)
        return "_" + text.replace(/[^\w]+/g, "_") + "_" + getNodeId(node) + refMask(bindings)
    }

    export interface FieldAccessInfo {
        idx: number;
        name: string;
        isRef: boolean;
        shimName: string;
    }

    export type VarOrParam = VariableDeclaration | ParameterDeclaration | PropertyDeclaration;

    export interface VariableAddInfo {
        captured?: boolean;
        written?: boolean;
    }

    export interface FunctionAddInfo {
        capturedVars: VarOrParam[];
        location?: ir.Cell;
        thisParameter?: ParameterDeclaration; // a bit bogus
        usages?: TypeBinding[][];
        prePassUsagesEmitted?: number;
    }

    export function compileBinary(program: Program, host: CompilerHost, opts: CompileOptions, res: CompileResult): EmitResult {
        const diagnostics = createDiagnosticCollection();
        checker = program.getTypeChecker();
        let classInfos: StringMap<ClassInfo> = {}
        let usedDecls: StringMap<boolean> = {}
        let usedWorkList: Declaration[] = []
        let variableStatus: StringMap<VariableAddInfo> = {};
        let functionInfo: StringMap<FunctionAddInfo> = {};
        let irCachesToClear: NodeWithCache[] = []

        if (opts.target.isNative) {
            if (!opts.hexinfo) {
                // we may have not been able to compile or download the hex file
                return {
                    diagnostics: [{
                        file: program.getSourceFiles()[0],
                        start: 0,
                        length: 0,
                        category: DiagnosticCategory.Error,
                        code: 9043,
                        messageText: lf("The hex file is not available, please connect to internet and try again.")
                    }],
                    emitSkipped: true
                };
            }

            hex.setupFor(opts.extinfo || emptyExtInfo(), opts.hexinfo);
            hex.setupInlineAssembly(opts);

            opts.breakpoints = true
        }


        let bin: Binary;
        let proc: ir.Procedure;

        function reset() {
            bin = new Binary();
            bin.res = res;
            bin.target = opts.target;
            proc = null
            if (opts.breakpoints)
                res.breakpoints = [{
                    id: 0,
                    isDebuggerStmt: false,
                    fileName: "bogus",
                    start: 0,
                    length: 0,
                    line: 0,
                    character: 0,
                    successors: null
                }]
        }

        if (opts.computeUsedSymbols) {
            res.usedSymbols = {}
            res.usedArguments = {}
        }

        let allStmts = Util.concat(program.getSourceFiles().map(f => f.statements))

        let src = program.getSourceFiles()[0]
        let rootFunction = <any>{
            kind: SK.FunctionDeclaration,
            parameters: [],
            name: {
                text: "<main>",
                pos: 0,
                end: 0
            },
            body: {
                kind: SK.Block,
                statements: allStmts
            },
            parent: src,
            pos: 0,
            end: 0,
            isRootFunction: true
        }

        markUsed(rootFunction);
        usedWorkList = [];

        reset();
        emit(rootFunction)

        if (diagnostics.getModificationCount() == 0) {
            reset();
            bin.finalPass = true
            emit(rootFunction)

            catchErrors(rootFunction, finalEmit)
        }

        return {
            diagnostics: diagnostics.getDiagnostics(),
            emitSkipped: !!opts.noEmit
        }

        function error(node: Node, code: number, msg: string, arg0?: any, arg1?: any, arg2?: any) {
            diagnostics.add(createDiagnosticForNode(node, <any>{
                code: code,
                message: msg,
                key: msg.replace(/^[a-zA-Z]+/g, "_"),
                category: DiagnosticCategory.Error,
            }, arg0, arg1, arg2));
        }

        function unhandled(n: Node, info?: string, code: number = 9202) {
            //If we info then we may as well present that instead
            if (info) {
                return userError(code, info)
            }

            if (!n) {
                //Not displayed to the user, therefore no need for lf on this
                console.log(`Error: ${getName(n)} is not a supported syntax feature`)
                userError(code, lf("Sorry, this language feature isn't supported"))
            }

            let syntax = stringKind(n)
            let maybeSupportInFuture = false
            let alternative: string = null
            switch (n.kind) {
                case ts.SyntaxKind.ForInStatement:
                    syntax = lf("for in loops")
                    break
                case ts.SyntaxKind.ForOfStatement:
                    syntax = lf("for of loops")
                    maybeSupportInFuture = true
                    break
                case ts.SyntaxKind.PropertyAccessExpression:
                    syntax = lf("property access")
                    break
                case ts.SyntaxKind.DeleteExpression:
                    syntax = lf("delete")
                    break
                case ts.SyntaxKind.GetAccessor:
                    syntax = lf("get accessor method")
                    maybeSupportInFuture = true
                    break
                case ts.SyntaxKind.SetAccessor:
                    syntax = lf("set accessor method")
                    maybeSupportInFuture = true
                    break
                case ts.SyntaxKind.TaggedTemplateExpression:
                    syntax = lf("tagged templates")
                    break
                case ts.SyntaxKind.ObjectLiteralExpression:
                    syntax = lf("object literals")
                    alternative = lf("define a class instead")
                    break
                case ts.SyntaxKind.TypeOfExpression:
                    syntax = lf("typeof")
                    break
                case ts.SyntaxKind.SpreadElementExpression:
                    syntax = lf("spread")
                    break
                case ts.SyntaxKind.TryStatement:
                case ts.SyntaxKind.CatchClause:
                case ts.SyntaxKind.FinallyKeyword:
                case ts.SyntaxKind.ThrowStatement:
                    syntax = lf("throwing and catching exceptions")
                    break
                case ts.SyntaxKind.ClassExpression:
                    syntax = lf("class expressions")
                    alternative = lf("declare a class as class C {} not let C = class {}")
                    break
                default:
                    break
            }

            let msg = ""
            if (maybeSupportInFuture) {
                msg = lf("{0} not currently supported", syntax)
            }
            else {
                msg = lf("{0} not supported", syntax)
            }

            if (alternative) {
                msg += " - " + alternative
            }

            return userError(code, msg)
        }

        function nodeKey(f: Node) {
            return getNodeId(f) + ""
        }

        function getFunctionInfo(f: FunctionLikeDeclaration) {
            let key = nodeKey(f)
            let info = functionInfo[key]
            if (!info)
                functionInfo[key] = info = {
                    capturedVars: []
                }
            return info
        }

        function getVarInfo(v: Declaration) {
            let key = getNodeId(v) + ""
            let info = variableStatus[key]
            if (!info)
                variableStatus[key] = info = {}
            return info;
        }

        function recordUse(v: VarOrParam, written = false) {
            let info = getVarInfo(v)
            if (written)
                info.written = true;
            let varParent = getEnclosingFunction(v)
            if (varParent == null || varParent == proc.action) {
                // not captured
            } else {
                let curr = proc.action
                while (curr && curr != varParent) {
                    let info2 = getFunctionInfo(curr)
                    if (info2.capturedVars.indexOf(v) < 0)
                        info2.capturedVars.push(v);
                    curr = getEnclosingFunction(curr)
                }
                info.captured = true;
            }
        }

        function scope(f: () => void) {
            let prevProc = proc;
            let prevBindings = typeBindings.slice()
            try {
                f();
            } finally {
                proc = prevProc;
                typeBindings = prevBindings
            }
        }

        function finalEmit() {
            if (diagnostics.getModificationCount() || opts.noEmit || !host)
                return;

            bin.writeFile = (fn: string, data: string) =>
                host.writeFile(fn, data, false, null);

            if (opts.target.isNative) {
                thumbEmit(bin, opts, res)
            } else {
                jsEmit(bin)
            }
        }

        function typeCheckVar(decl: Declaration) {
            if (!decl) {
                userError(9203, lf("variable has unknown type"))
            }
            if (typeOf(decl).flags & TypeFlags.Void) {
                userError(9203, lf("void-typed variables not supported"))
            }
        }

        function lookupCell(decl: Declaration): ir.Cell {
            if (isGlobalVar(decl)) {
                markUsed(decl)
                typeCheckVar(decl)
                let ex = bin.globals.filter(l => l.def == decl)[0]
                if (!ex) {
                    ex = new ir.Cell(bin.globals.length + numReservedGlobals, decl, getVarInfo(decl))
                    bin.globals.push(ex)
                }
                return ex
            } else {
                let res = proc.localIndex(decl)
                if (!res) {
                    if (bin.finalPass)
                        userError(9204, lf("cannot locate identifer"))
                    else
                        res = proc.mkLocal(decl, getVarInfo(decl))
                }
                return res
            }
        }

        function getClassInfo(t: Type) {
            let decl = <ClassDeclaration>t.symbol.valueDeclaration
            let bindings = getTypeBindings(t)
            let id = getNodeId(decl) + refMask(bindings)
            let info = classInfos[id]
            if (!info) {
                info = {
                    reffields: [],
                    primitivefields: [],
                    allfields: null,
                    attrs: parseComments(decl)
                }
                classInfos[id] = info;
                scope(() => {
                    U.pushRange(typeBindings, bindings)
                    for (let mem of decl.members) {
                        if (mem.kind == SK.PropertyDeclaration) {
                            let pdecl = <PropertyDeclaration>mem
                            if (isRefType(typeOf(pdecl)))
                                info.reffields.push(pdecl)
                            else info.primitivefields.push(pdecl)
                        }
                    }
                })
                info.allfields = info.reffields.concat(info.primitivefields)
            }
            return info;
        }

        function emitImageLiteral(s: string): LiteralExpression {
            if (!s) s = "0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n";

            let x = 0;
            let w = 0;
            let h = 0;
            let lit = "";
            s += "\n"
            for (let i = 0; i < s.length; ++i) {
                switch (s[i]) {
                    case ".":
                    case "_":
                    case "0": lit += "0,"; x++; break;
                    case "#":
                    case "*":
                    case "1": lit += "1,"; x++; break;
                    case "\t":
                    case "\r":
                    case " ": break;
                    case "\n":
                        if (x) {
                            if (w == 0)
                                w = x;
                            else if (x != w)
                                userError(9205, lf("lines in image literal have to have the same width (got {0} and then {1} pixels)", w, x))
                            x = 0;
                            h++;
                        }
                        break;
                    default:
                        userError(9206, lf("Only 0 . _ (off) and 1 # * (on) are allowed in image literals"))
                }
            }

            let lbl = "_img" + bin.lblNo++
            if (lit.length % 4 != 0)
                lit += "42" // pad

            bin.otherLiterals.push(`
.balign 4
${lbl}: .short 0xffff
        .short ${w}, ${h}
        .byte ${lit}
`)
            let jsLit = "new pxsim.Image(" + w + ", [" + lit + "])"

            return <any>{
                kind: SK.NumericLiteral,
                imageLiteral: lbl,
                jsLit
            }
        }

        function emitLocalLoad(decl: VarOrParam) {
            let l = lookupCell(decl)
            recordUse(decl)
            let r = l.load()
            //console.log("LOADLOC", l.toString(), r.toString())
            return r
        }

        function emitFunLiteral(f: FunctionDeclaration) {
            let attrs = parseComments(f);
            if (attrs.shim)
                userError(9207, lf("built-in functions cannot be yet used as values; did you forget ()?"))
            if (isGenericFunction(f))
                userError(9232, lf("generic functions cannot be yet used as values; did you forget ()?"))
            let info = getFunctionInfo(f)
            if (info.location) {
                return info.location.load()
            } else {
                assert(!bin.finalPass || info.capturedVars.length == 0)
                return emitFunLitCore(f)
            }
        }

        function emitIdentifier(node: Identifier): ir.Expr {
            let decl = getDecl(node)
            if (decl && (decl.kind == SK.VariableDeclaration || decl.kind == SK.Parameter)) {
                return emitLocalLoad(<VarOrParam>decl)
            } else if (decl && decl.kind == SK.FunctionDeclaration) {
                return emitFunLiteral(decl as FunctionDeclaration)
            } else {
                if (node.text == "undefined")
                    throw unhandled(node, lf("undefined not supported"), 9200)
                else
                    throw unhandled(node, lf("Unknown or undeclared identifier"), 9235)
            }
        }

        function emitParameter(node: ParameterDeclaration) { }
        function emitAccessor(node: AccessorDeclaration) {
            emitFunctionDeclaration(node)
        }
        function emitThis(node: Node) {
            let meth = getEnclosingMethod(node)
            if (!meth)
                userError(9208, lf("'this' used outside of a method"))
            let inf = getFunctionInfo(meth)
            if (!inf.thisParameter) {
                //console.log("get this param,", meth.kind, nodeKey(meth))
                //console.log("GET", meth)
                oops("no this")
            }
            return emitLocalLoad(inf.thisParameter)
        }
        function emitSuper(node: Node) { }
        function emitLiteral(node: LiteralExpression) {
            if (node.kind == SK.NumericLiteral) {
                if ((<any>node).imageLiteral) {
                    return ir.ptrlit((<any>node).imageLiteral, (<any>node).jsLit)
                } else {
                    return ir.numlit(parseInt(node.text))
                }
            } else if (isStringLiteral(node)) {
                if (node.text == "") {
                    return ir.rtcall("String_::mkEmpty", [])
                } else {
                    let lbl = bin.emitString(node.text)
                    let ptr = ir.ptrlit(lbl + "meta", JSON.stringify(node.text))
                    return ir.rtcall("pxt::ptrOfLiteral", [ptr])
                }
            } else {
                throw oops();
            }
        }

        function emitTemplateExpression(node: TemplateExpression) {
            let concat = (a: ir.Expr, b: Expression | TemplateLiteralFragment) =>
                isEmptyStringLiteral(b) ? a :
                    ir.rtcallMask("String_::concat", 3, ir.CallingConvention.Plain, [
                        a,
                        emitAsString(b)
                    ])
            // TODO could optimize for the case where node.head is empty
            let expr = emitAsString(node.head)
            for (let span of node.templateSpans) {
                expr = concat(expr, span.expression)
                expr = concat(expr, span.literal)
            }
            return expr
        }

        function emitTemplateSpan(node: TemplateSpan) { }
        function emitJsxElement(node: JsxElement) { }
        function emitJsxSelfClosingElement(node: JsxSelfClosingElement) { }
        function emitJsxText(node: JsxText) { }
        function emitJsxExpression(node: JsxExpression) { }
        function emitQualifiedName(node: QualifiedName) { }
        function emitObjectBindingPattern(node: BindingPattern) { }
        function emitArrayBindingPattern(node: BindingPattern) { }
        function emitBindingElement(node: BindingElement) { }
        function emitArrayLiteral(node: ArrayLiteralExpression) {
            let eltT = arrayElementType(typeOf(node))
            let isRef = isRefType(eltT)
            let flag = 0
            if (eltT.flags & TypeFlags.String)
                flag = 3;
            else if (isRef)
                flag = 1;
            let coll = ir.shared(ir.rtcall("Array_::mk", [ir.numlit(flag)]))
            for (let elt of node.elements) {
                let e = ir.shared(emitExpr(elt))
                proc.emitExpr(ir.rtcall("Array_::push", [coll, e]))
                if (isRef) {
                    proc.emitExpr(ir.op(EK.Decr, [e]))
                }
            }
            return coll
        }
        function emitObjectLiteral(node: ObjectLiteralExpression) { }
        function emitPropertyAssignment(node: PropertyDeclaration) {
            if (isStatic(node)) {
                emitVariableDeclaration(node)
                return
            }
            if (node.initializer)
                userError(9209, lf("class field initializers not supported"))
            // do nothing
        }
        function emitShorthandPropertyAssignment(node: ShorthandPropertyAssignment) { }
        function emitComputedPropertyName(node: ComputedPropertyName) { }
        function emitPropertyAccess(node: PropertyAccessExpression): ir.Expr {
            let decl = getDecl(node);
            if (decl.kind == SK.GetAccessor) {
                return emitCallCore(node, node, [], null)
            }
            let attrs = parseComments(decl);
            let callInfo: CallInfo = {
                decl,
                qName: getFullName(checker, decl.symbol),
                attrs,
                args: []
            };
            (node as any).callInfo = callInfo;
            if (decl.kind == SK.EnumMember) {
                let ev = attrs.enumval
                if (!ev) {
                    let val = checker.getConstantValue(decl as EnumMember)
                    if (val == null) {
                        if ((decl as EnumMember).initializer)
                            return emitExpr((decl as EnumMember).initializer)
                        userError(9210, lf("Cannot compute enum value"))
                    }
                    ev = val + ""
                }
                if (/^\d+$/.test(ev))
                    return ir.numlit(parseInt(ev));
                return ir.rtcall(ev, [])
            } else if (decl.kind == SK.PropertySignature) {
                if (attrs.shim) {
                    callInfo.args.push(node.expression)
                    return emitShim(decl, node, [node.expression])
                } else {
                    throw unhandled(node, lf("no {shim:...}"), 9236);
                }
            } else if (decl.kind == SK.PropertyDeclaration) {
                if (isStatic(decl)) {
                    return emitLocalLoad(decl as PropertyDeclaration)
                }
                let idx = fieldIndex(node)
                callInfo.args.push(node.expression)
                return ir.op(EK.FieldAccess, [emitExpr(node.expression)], idx)
            } else if (isClassFunction(decl) || decl.kind == SK.MethodSignature) {
                throw userError(9211, lf("cannot use method as lambda; did you forget '()' ?"))
            } else if (decl.kind == SK.FunctionDeclaration) {
                return emitFunLiteral(decl as FunctionDeclaration)
            } else {
                throw unhandled(node, lf("Unknown property access for {0}", stringKind(decl)), 9237);
            }
        }

        function emitIndexedAccess(node: ElementAccessExpression, assign: ir.Expr = null): ir.Expr {
            let t = typeOf(node.expression)

            let indexer: string = null
            if (!assign && t.flags & TypeFlags.String)
                indexer = "String_::charAt"
            else if (isArrayType(t))
                indexer = assign ? "Array_::setAt" : "Array_::getAt"
            else if (isInterfaceType(t)) {
                let attrs = parseCommentsOnSymbol(t.symbol)
                indexer = assign ? attrs.indexerSet : attrs.indexerGet
            }

            if (indexer) {
                if (typeOf(node.argumentExpression).flags & TypeFlags.Number) {
                    let args = [node.expression, node.argumentExpression]
                    return rtcallMask(indexer, args, ir.CallingConvention.Plain, assign ? [assign] : [])
                } else {
                    throw unhandled(node, lf("non-numeric indexer on {0}", indexer), 9238)
                }
            } else {
                throw unhandled(node, lf("unsupported indexer"), 9239)
            }
        }

        function isOnDemandDecl(decl: Declaration) {
            let res = (isGlobalVar(decl) && !isSideEffectfulInitializer((<VariableDeclaration>decl).initializer)) ||
                isTopLevelFunctionDecl(decl)
            if (opts.testMode && res) {
                if (!U.startsWith(getSourceFileOfNode(decl).fileName, "pxt_modules"))
                    return false
            }
            return res
        }

        function isUsed(decl: Declaration) {
            return !isOnDemandDecl(decl) || usedDecls.hasOwnProperty(nodeKey(decl))
        }

        function markFunctionUsed(decl: FunctionLikeDeclaration, bindings: TypeBinding[]) {
            if (!bindings || !bindings.length) markUsed(decl)
            else {
                let info = getFunctionInfo(decl)
                if (!info.usages) {
                    usedDecls[nodeKey(decl)] = true
                    info.usages = []
                    info.prePassUsagesEmitted = 0

                    if (opts.computeUsedSymbols && decl && decl.symbol)
                        res.usedSymbols[getFullName(checker, decl.symbol)] = null
                }
                let mask = refMask(bindings)
                if (!info.usages.some(u => refMask(u) == mask)) {
                    info.usages.push(bindings)
                    usedWorkList.push(decl)
                }
            }
        }

        function markUsed(decl: Declaration) {
            if (opts.computeUsedSymbols && decl && decl.symbol)
                res.usedSymbols[getFullName(checker, decl.symbol)] = null

            if (decl && !isUsed(decl)) {
                usedDecls[nodeKey(decl)] = true
                usedWorkList.push(decl)
            }
        }

        function getDecl(node: Node): Declaration {
            if (!node) return null
            let sym = checker.getSymbolAtLocation(node)
            let decl: Declaration = sym ? sym.valueDeclaration : null
            markUsed(decl)
            return decl
        }
        function isRefCountedExpr(e: Expression) {
            // we generate a fake NULL expression for default arguments
            // we also generate a fake numeric literal for image literals
            if (e.kind == SK.NullKeyword || e.kind == SK.NumericLiteral)
                return !!(e as any).isRefOverride
            // no point doing the incr/decr for these - they are statically allocated anyways
            if (isStringLiteral(e))
                return false
            return isRefType(typeOf(e))
        }
        function getMask(args: Expression[]) {
            assert(args.length <= 8)
            let m = 0
            args.forEach((a, i) => {
                if (isRefCountedExpr(a))
                    m |= (1 << i)
            })
            return m
        }

        function emitShim(decl: Declaration, node: Node, args: Expression[]): ir.Expr {
            let attrs = parseComments(decl)
            let hasRet = !(typeOf(node).flags & TypeFlags.Void)
            let nm = attrs.shim

            if (nm == "TD_NOOP") {
                assert(!hasRet)
                return ir.numlit(0)
            }

            if (nm == "TD_ID") {
                assert(args.length == 1)
                return emitExpr(args[0])
            }

            if (opts.target.isNative) {
                hex.validateShim(getDeclName(decl), attrs, hasRet, args.length);
            }

            return rtcallMask(attrs.shim, args, attrs.callingConvention)
        }

        function isNumericLiteral(node: Expression) {
            switch (node.kind) {
                case SK.NullKeyword:
                case SK.TrueKeyword:
                case SK.FalseKeyword:
                case SK.NumericLiteral:
                    return true;
                default:
                    return false;
            }
        }

        function addDefaultParameters(sig: Signature, args: Expression[], attrs: CommentAttrs) {
            if (!sig) return;
            let parms = sig.getParameters();
            if (parms.length > args.length) {
                parms.slice(args.length).forEach(p => {
                    if (p.valueDeclaration &&
                        p.valueDeclaration.kind == SK.Parameter) {
                        let prm = <ParameterDeclaration>p.valueDeclaration
                        if (!prm.initializer) {
                            let defl = attrs.paramDefl[getName(prm)]
                            args.push(irToNode(defl ? ir.numlit(parseInt(defl)) : null))
                        } else {
                            if (!isNumericLiteral(prm.initializer)) {
                                userError(9212, lf("only numbers, null, true and false supported as default arguments"))
                            }
                            args.push(prm.initializer)
                        }
                    } else {
                        userError(9213, lf("unsupported default argument (shouldn't happen)"))
                    }
                })
            }

            if (attrs.imageLiteral) {
                if (!isStringLiteral(args[0])) {
                    userError(9214, lf("Only image literals (string literals) supported here; {0}", stringKind(args[0])))
                }

                args[0] = emitImageLiteral((args[0] as StringLiteral).text)
            }
        }

        function emitCallExpression(node: CallExpression): ir.Expr {
            let sig = checker.getResolvedSignature(node)
            return emitCallCore(node, node.expression, node.arguments, sig)
        }

        function emitCallCore(
            node: Expression,
            funcExpr: Expression,
            callArgs: Expression[],
            sig: Signature,
            decl: FunctionLikeDeclaration = null
        ): ir.Expr {
            if (!decl)
                decl = getDecl(funcExpr) as FunctionLikeDeclaration
            if (!decl)
                unhandled(node, lf("no declaration"), 9240)
            let attrs = parseComments(decl)
            let hasRet = !(typeOf(node).flags & TypeFlags.Void)
            let args = callArgs.slice(0)
            let callInfo: CallInfo = {
                decl,
                qName: getFullName(checker, decl.symbol),
                attrs,
                args: args.slice(0)
            };
            (node as any).callInfo = callInfo

            let bindings: TypeBinding[] = []

            if (sig) {
                let trg: Signature = (sig as any).target
                let typeParams = sig.typeParameters || (trg ? trg.typeParameters : null) || []
                bindings = getTypeBindingsCore(typeParams, typeParams.map(x => (sig as any).mapper(x)))
            }
            let isSelfGeneric = bindings.length > 0
            addEnclosingTypeBindings(bindings, decl)

            if (res.usedArguments && attrs.trackArgs) {
                let tracked = attrs.trackArgs.map(n => args[n]).map(e => {
                    let d = getDecl(e)
                    if (d && d.kind == SK.EnumMember)
                        return getFullName(checker, d.symbol)
                    else return "*"
                }).join(",")
                let fn = getFullName(checker, decl.symbol)
                let lst = res.usedArguments[fn]
                if (!lst) {
                    lst = res.usedArguments[fn] = []
                }
                if (lst.indexOf(tracked) < 0)
                    lst.push(tracked)
            }

            function emitPlain() {
                return mkProcCall(decl, args.map(emitExpr), bindings)
            }

            addDefaultParameters(sig, args, attrs);

            if (decl.kind == SK.FunctionDeclaration) {
                let info = getFunctionInfo(<FunctionDeclaration>decl)

                if (!info.location) {
                    if (attrs.shim) {
                        return emitShim(decl, node, args);
                    }

                    markFunctionUsed(decl, bindings)
                    return emitPlain();
                }
            }

            if (decl.kind == SK.MethodSignature ||
                decl.kind == SK.GetAccessor ||
                decl.kind == SK.SetAccessor ||
                decl.kind == SK.MethodDeclaration) {
                if (isStatic(decl)) {
                    // no additional arguments
                } else if (funcExpr.kind == SK.PropertyAccessExpression) {
                    let recv = (<PropertyAccessExpression>funcExpr).expression
                    args.unshift(recv)
                    callInfo.args.unshift(recv)
                    bindings = getTypeBindings(typeOf(recv)).concat(bindings)
                } else
                    unhandled(node, lf("strange method call"), 9241)
                if (attrs.shim) {
                    return emitShim(decl, node, args);
                } else if (attrs.helper) {
                    let syms = checker.getSymbolsInScope(node, SymbolFlags.Module)
                    let helpersModule = <ModuleDeclaration>syms.filter(s => s.name == "helpers")[0].valueDeclaration;
                    let helperStmt = (<ModuleBlock>helpersModule.body).statements.filter(s => s.symbol.name == attrs.helper)[0]
                    if (!helperStmt)
                        userError(9215, lf("helpers.{0} not found", attrs.helper))
                    if (helperStmt.kind != SK.FunctionDeclaration)
                        userError(9216, lf("helpers.{0} isn't a function", attrs.helper))
                    decl = <FunctionDeclaration>helperStmt;
                    let sig = checker.getSignatureFromDeclaration(decl)
                    let tp = sig.getTypeParameters() || []
                    if (tp.length != bindings.length)
                        U.oops("helpers type parameter mismatch") // can it happen?
                    bindings.forEach((b, i) => {
                        b.tp = tp[i]
                    })
                    markFunctionUsed(decl, bindings)
                    return emitPlain();
                } else {
                    markFunctionUsed(decl, bindings)
                    return emitPlain();
                }
            }

            if (isSelfGeneric)
                U.oops("invalid generic call")

            if (decl.kind == SK.VariableDeclaration ||
                decl.kind == SK.FunctionDeclaration || // this is lambda
                decl.kind == SK.Parameter) {
                if (args.length > 3)
                    userError(9217, lf("lambda functions with more than 3 arguments not supported"))

                let suff = args.length + ""

                args.unshift(funcExpr)
                callInfo.args.unshift(funcExpr)

                // force mask=1 - i.e., do not decr() the arguments, only the action itself, 
                // because what we're calling is ultimately a procedure which will decr arguments itself
                return ir.rtcallMask("pxt::runAction" + suff, 1, ir.CallingConvention.Async, args.map(emitExpr))
            }

            if (decl.kind == SK.ModuleDeclaration) {
                if (getName(decl) == "String")
                    userError(9219, lf("to convert X to string use: X + \"\""))
                else
                    userError(9220, lf("namespaces cannot be called directly"))
            }

            throw unhandled(node, stringKind(decl), 9242)
        }

        function mkProcCall(decl: ts.Declaration, args: ir.Expr[], bindings: TypeBinding[]) {
            return ir.op(EK.ProcCall, args, {
                action: decl,
                bindings: bindings
            })
        }

        function emitNewExpression(node: NewExpression) {
            let t = typeOf(node)
            if (isArrayType(t)) {
                throw oops();
            } else if (isPossiblyGenericClassType(t)) {
                let classDecl = <ClassDeclaration>getDecl(node.expression)
                if (classDecl.kind != SK.ClassDeclaration) {
                    userError(9221, lf("new expression only supported on class types"))
                }
                let ctor = classDecl.members.filter(n => n.kind == SK.Constructor)[0]
                let info = getClassInfo(t)

                let obj = ir.shared(ir.rtcall("pxt::mkRecord", [ir.numlit(info.reffields.length), ir.numlit(info.allfields.length)]))

                if (ctor) {
                    markUsed(ctor)
                    let args = node.arguments.slice(0)
                    let ctorAttrs = parseComments(ctor)
                    addDefaultParameters(checker.getResolvedSignature(node), args, ctorAttrs)
                    let compiled = args.map(emitExpr)
                    if (ctorAttrs.shim)
                        // we drop 'obj' variable
                        return ir.rtcall(ctorAttrs.shim, compiled)
                    compiled.unshift(ir.op(EK.Incr, [obj]))
                    proc.emitExpr(mkProcCall(ctor, compiled, []))
                    return obj
                } else {
                    if (node.arguments && node.arguments.length)
                        userError(9222, lf("constructor with arguments not found"));
                    return obj;
                }
            } else {
                throw unhandled(node, lf("unknown type for new"), 9243)
            }
        }
        function emitTaggedTemplateExpression(node: TaggedTemplateExpression) { }
        function emitTypeAssertion(node: TypeAssertion) {
            return emitExpr(node.expression)
        }
        function emitAsExpression(node: AsExpression) {
            return emitExpr(node.expression)
        }
        function emitParenExpression(node: ParenthesizedExpression) {
            return emitExpr(node.expression)
        }

        function getParameters(node: FunctionLikeDeclaration) {
            let res = node.parameters.slice(0)
            if (!isStatic(node) && isClassFunction(node)) {
                let info = getFunctionInfo(node)
                if (!info.thisParameter) {
                    info.thisParameter = <any>{
                        kind: SK.Parameter,
                        name: { text: "this" },
                        isThisParameter: true,
                        parent: node
                    }
                }
                res.unshift(info.thisParameter)
            }
            return res
        }

        function emitFunLitCore(node: FunctionLikeDeclaration, raw = false) {
            let lbl = getFunctionLabel(node, getEnclosingTypeBindings(node))
            let r = ir.ptrlit(lbl + "_Lit", lbl)
            if (!raw) {
                r = ir.rtcall("pxt::ptrOfLiteral", [r])
            }
            return r
        }

        function emitFuncCore(node: FunctionLikeDeclaration, bindings: TypeBinding[]) {
            let info = getFunctionInfo(node)
            let lit: ir.Expr = null

            let isExpression = node.kind == SK.ArrowFunction || node.kind == SK.FunctionExpression

            let isRef = (d: Declaration) => {
                if (isRefDecl(d)) return true
                let info = getVarInfo(d)
                return (info.captured && info.written)
            }

            let refs = info.capturedVars.filter(v => isRef(v))
            let prim = info.capturedVars.filter(v => !isRef(v))
            let caps = refs.concat(prim)
            let locals = caps.map((v, i) => {
                let l = new ir.Cell(i, v, getVarInfo(v))
                l.iscap = true
                return l;
            })

            // forbid: let x = function<T>(a:T) { }
            if (isExpression && isGenericFunction(node))
                userError(9233, lf("function expressions cannot be generic"))

            if (caps.length > 0 && isGenericFunction(node))
                userError(9234, lf("nested functions cannot be generic yet"))

            // if no captured variables, then we can get away with a plain pointer to code
            if (caps.length > 0) {
                assert(getEnclosingFunction(node) != null)
                lit = ir.shared(ir.rtcall("pxt::mkAction", [ir.numlit(refs.length), ir.numlit(caps.length), emitFunLitCore(node, true)]))
                caps.forEach((l, i) => {
                    let loc = proc.localIndex(l)
                    if (!loc)
                        userError(9223, lf("cannot find captured value: {0}", checker.symbolToString(l.symbol)))
                    let v = loc.loadCore()
                    if (loc.isRef() || loc.isByRefLocal())
                        v = ir.op(EK.Incr, [v])
                    proc.emitExpr(ir.rtcall("pxtrt::stclo", [lit, ir.numlit(i), v]))
                })
                if (node.kind == SK.FunctionDeclaration) {
                    info.location = proc.mkLocal(node, getVarInfo(node))
                    proc.emitExpr(info.location.storeDirect(lit))
                    lit = null
                }
            } else {
                if (isExpression) {
                    lit = emitFunLitCore(node)
                }
            }

            assert(!!lit == isExpression)

            let isRoot = proc == null
            proc = new ir.Procedure();
            proc.isRoot = isRoot
            proc.action = node;
            proc.info = info;
            proc.captured = locals;
            proc.bindings = bindings;
            bin.addProc(proc);

            U.pushRange(typeBindings, bindings)

            proc.args = getParameters(node).map((p, i) => {
                let l = new ir.Cell(i, p, getVarInfo(p))
                l.isarg = true
                return l
            })

            proc.args.forEach(l => {
                //console.log(l.toString(), l.info)
                if (l.isByRefLocal()) {
                    // TODO add C++ support function to do this
                    let tmp = ir.shared(ir.rtcall("pxtrt::mkloc" + l.refSuffix(), []))
                    proc.emitExpr(ir.rtcall("pxtrt::stloc" + l.refSuffix(), [tmp, l.loadCore()]))
                    proc.emitExpr(l.storeDirect(tmp))
                }
            })

            if (node.body.kind == SK.Block) {
                emit(node.body);
            } else {
                let v = emitExpr(node.body)
                proc.emitJmp(getLabels(node).ret, v, ir.JmpMode.Always)
            }

            proc.emitLblDirect(getLabels(node).ret)

            proc.stackEmpty();

            if (funcHasReturn(proc.action)) {
                let v = ir.shared(ir.op(EK.JmpValue, []))
                proc.emitExpr(v) // make sure we save it
                proc.emitClrs();
                let lbl = proc.mkLabel("final")
                proc.emitJmp(lbl, v, ir.JmpMode.Always)
                proc.emitLbl(lbl)
            } else {
                proc.emitClrs();
            }

            assert(!bin.finalPass || usedWorkList.length == 0)
            while (usedWorkList.length > 0) {
                let f = usedWorkList.pop()
                emit(f)
            }

            return lit
        }

        function emitFunctionDeclaration(node: FunctionLikeDeclaration) {
            if (!isUsed(node))
                return;

            let attrs = parseComments(node)
            if (attrs.shim != null) {
                if (opts.target.isNative) {
                    hex.validateShim(getDeclName(node),
                        attrs,
                        funcHasReturn(node),
                        getParameters(node).length);
                }
                return
            }

            if (node.flags & NodeFlags.Ambient)
                return;

            if (!node.body)
                return;

            let info = getFunctionInfo(node)
            let lit: ir.Expr = null

            if (isGenericFunction(node)) {
                if (!info.usages) {
                    if (bin.finalPass && !usedDecls[nodeKey(node)]) {
                        // test mode - make fake binding
                        let sig = checker.getSignatureFromDeclaration(node)
                        let bindings = sig.getTypeParameters().map(t => ({ tp: t, isRef: true }))
                        addEnclosingTypeBindings(bindings, node)
                        U.assert(bindings.length > 0)
                        info.usages = [bindings]
                    } else {
                        U.assert(!bin.finalPass)
                        return null
                    }
                }
                U.assert(info.usages.length > 0, "no generic usages recorded")
                let todo = info.usages
                if (!bin.finalPass) {
                    todo = info.usages.slice(info.prePassUsagesEmitted)
                    info.prePassUsagesEmitted = info.usages.length
                }
                for (let bindings of todo) {
                    scope(() => {
                        let nolit = emitFuncCore(node, bindings)
                        U.assert(nolit == null)
                    })
                }
            } else {
                scope(() => {
                    lit = emitFuncCore(node, getEnclosingTypeBindings(node))
                })
            }

            return lit
        }

        function emitDeleteExpression(node: DeleteExpression) { }
        function emitTypeOfExpression(node: TypeOfExpression) { }
        function emitVoidExpression(node: VoidExpression) { }
        function emitAwaitExpression(node: AwaitExpression) { }
        function emitPrefixUnaryExpression(node: PrefixUnaryExpression): ir.Expr {
            let tp = typeOf(node.operand)
            if (tp.flags & TypeFlags.Boolean) {
                if (node.operator == SK.ExclamationToken) {
                    return rtcallMask("Boolean_::bang", [node.operand])
                }
            }

            if (tp.flags & TypeFlags.Number) {
                switch (node.operator) {
                    case SK.PlusPlusToken:
                        return emitIncrement(node.operand, "thumb::adds", false)
                    case SK.MinusMinusToken:
                        return emitIncrement(node.operand, "thumb::subs", false)
                    case SK.MinusToken:
                        return ir.rtcall("thumb::subs", [ir.numlit(0), emitExpr(node.operand)])
                    case SK.PlusToken:
                        return emitExpr(node.operand) // no-op
                    default:
                        break
                }
            }

            throw unhandled(node, lf("unsupported prefix unary operation"), 9245)
        }

        function doNothing() { }

        function needsCache(e: Expression) {
            let c = e as NodeWithCache
            c.needsIRCache = true
            irCachesToClear.push(c)
        }

        function prepForAssignment(trg: Expression, src: Expression = null) {
            let prev = irCachesToClear.length
            if (trg.kind == SK.PropertyAccessExpression || trg.kind == SK.ElementAccessExpression) {
                needsCache((trg as PropertyAccessExpression).expression)
            }
            if (src)
                needsCache(src)
            if (irCachesToClear.length == prev)
                return doNothing
            else
                return () => {
                    for (let i = prev; i < irCachesToClear.length; ++i) {
                        irCachesToClear[i].cachedIR = null
                        irCachesToClear[i].needsIRCache = false
                    }
                    irCachesToClear.splice(prev, irCachesToClear.length - prev)
                }
        }

        function irToNode(expr: ir.Expr, isRef = false): Expression {
            return {
                kind: SK.NullKeyword,
                isRefOverride: isRef,
                valueOverride: expr
            } as any
        }

        function emitIncrement(trg: Expression, meth: string, isPost: boolean, one: Expression = null) {
            let cleanup = prepForAssignment(trg)
            let oneExpr = one ? emitExpr(one) : ir.numlit(1)
            let prev = ir.shared(emitExpr(trg))
            let result = ir.shared(ir.rtcall(meth, [prev, oneExpr]))
            emitStore(trg, irToNode(result))
            cleanup()
            return isPost ? prev : result
        }

        function emitPostfixUnaryExpression(node: PostfixUnaryExpression): ir.Expr {
            let tp = typeOf(node.operand)

            if (tp.flags & TypeFlags.Number) {
                switch (node.operator) {
                    case SK.PlusPlusToken:
                        return emitIncrement(node.operand, "thumb::adds", true)
                    case SK.MinusMinusToken:
                        return emitIncrement(node.operand, "thumb::subs", true)
                    default:
                        break
                }
            }
            throw unhandled(node, lf("unsupported postfix unary operation"), 9246)
        }

        function fieldIndex(pacc: PropertyAccessExpression): FieldAccessInfo {
            let tp = typeOf(pacc.expression)
            if (isPossiblyGenericClassType(tp)) {
                let info = getClassInfo(tp)
                let fld = info.allfields.filter(f => (<Identifier>f.name).text == pacc.name.text)[0]
                if (!fld)
                    userError(9224, lf("field {0} not found", pacc.name.text))
                let attrs = parseComments(fld)
                return {
                    idx: info.allfields.indexOf(fld),
                    name: pacc.name.text,
                    isRef: isRefType(typeOf(pacc)),
                    shimName: attrs.shim
                }
            } else {
                throw unhandled(pacc, lf("bad field access"), 9247)
            }
        }

        function emitStore(trg: Expression, src: Expression) {
            let decl = getDecl(trg)
            let isGlobal = isGlobalVar(decl)
            if (trg.kind == SK.Identifier || isGlobal) {
                if (decl && (isGlobal || decl.kind == SK.VariableDeclaration || decl.kind == SK.Parameter)) {
                    let l = lookupCell(decl)
                    recordUse(<VarOrParam>decl, true)
                    proc.emitExpr(l.storeByRef(emitExpr(src)))
                } else {
                    unhandled(trg, lf("bad target identifier"), 9248)
                }
            } else if (trg.kind == SK.PropertyAccessExpression) {
                let decl = getDecl(trg)
                if (decl && decl.kind == SK.GetAccessor) {
                    decl = getDeclarationOfKind(decl.symbol, SK.SetAccessor)
                    if (!decl) {
                        unhandled(trg, lf("setter not available"), 9253)
                    }
                    proc.emitExpr(emitCallCore(trg, trg, [src], null, decl as FunctionLikeDeclaration))
                } else {
                    proc.emitExpr(ir.op(EK.Store, [emitExpr(trg), emitExpr(src)]))
                }
            } else if (trg.kind == SK.ElementAccessExpression) {
                proc.emitExpr(emitIndexedAccess(trg as ElementAccessExpression, emitExpr(src)))
            } else {
                unhandled(trg, lf("bad assignment target"), 9249)
            }
        }

        function handleAssignment(node: BinaryExpression) {
            let cleanup = prepForAssignment(node.left, node.right)
            emitStore(node.left, node.right)
            let res = emitExpr(node.right)
            cleanup()
            return res
        }

        function rtcallMask(name: string, args: Expression[], callingConv = ir.CallingConvention.Plain, append: ir.Expr[] = null) {
            let args2 = args.map(emitExpr)
            if (append) args2 = args2.concat(append)
            return ir.rtcallMask(name, getMask(args), callingConv, args2)
        }

        function emitInJmpValue(expr: ir.Expr) {
            let lbl = proc.mkLabel("ldjmp")
            proc.emitJmp(lbl, expr, ir.JmpMode.Always)
            proc.emitLbl(lbl)
        }

        function emitLazyBinaryExpression(node: BinaryExpression) {
            let lbl = proc.mkLabel("lazy")
            // TODO what if the value is of ref type?
            if (node.operatorToken.kind == SK.BarBarToken) {
                proc.emitJmp(lbl, emitExpr(node.left), ir.JmpMode.IfNotZero)
            } else if (node.operatorToken.kind == SK.AmpersandAmpersandToken) {
                proc.emitJmpZ(lbl, emitExpr(node.left))
            } else {
                oops()
            }

            proc.emitJmp(lbl, emitExpr(node.right), ir.JmpMode.Always)
            proc.emitLbl(lbl)

            return ir.op(EK.JmpValue, [])
        }

        function stripEquals(k: SyntaxKind) {
            switch (k) {
                case SK.PlusEqualsToken: return SK.PlusToken;
                case SK.MinusEqualsToken: return SK.MinusToken;
                case SK.AsteriskEqualsToken: return SK.AsteriskToken;
                case SK.AsteriskAsteriskEqualsToken: return SK.AsteriskAsteriskToken;
                case SK.SlashEqualsToken: return SK.SlashToken;
                case SK.PercentEqualsToken: return SK.PercentToken;
                case SK.LessThanLessThanEqualsToken: return SK.LessThanLessThanToken;
                case SK.GreaterThanGreaterThanEqualsToken: return SK.GreaterThanGreaterThanToken;
                case SK.GreaterThanGreaterThanGreaterThanEqualsToken: return SK.GreaterThanGreaterThanGreaterThanToken;
                case SK.AmpersandEqualsToken: return SK.AmpersandToken;
                case SK.BarEqualsToken: return SK.BarToken;
                case SK.CaretEqualsToken: return SK.CaretToken;
                default: return SK.Unknown;
            }
        }

        function emitBrk(node: Node) {
            if (!opts.breakpoints) return
            let src = getSourceFileOfNode(node)
            if (opts.justMyCode && U.startsWith(src.fileName, "pxt_modules"))
                return;
            let pos = node.pos
            while (/^\s$/.exec(src.text[pos]))
                pos++;
            let p = ts.getLineAndCharacterOfPosition(src, pos)
            let brk: Breakpoint = {
                id: res.breakpoints.length,
                isDebuggerStmt: node.kind == SK.DebuggerStatement,
                fileName: src.fileName,
                start: pos,
                length: node.end - pos,
                line: p.line,
                character: p.character,
                successors: null
            }
            res.breakpoints.push(brk)
            let st = ir.stmt(ir.SK.Breakpoint, null)
            st.breakpointInfo = brk
            proc.emit(st)
        }

        function simpleInstruction(k: SyntaxKind) {
            switch (k) {
                case SK.PlusToken: return "thumb::adds";
                case SK.MinusToken: return "thumb::subs";
                // we could expose __aeabi_idiv directly...
                case SK.SlashToken: return "Number_::div";
                case SK.PercentToken: return "Number_::mod";
                case SK.AsteriskToken: return "thumb::muls";
                case SK.AmpersandToken: return "thumb::ands";
                case SK.BarToken: return "thumb::orrs";
                case SK.CaretToken: return "thumb::eors";
                case SK.LessThanLessThanToken: return "thumb::lsls";
                case SK.GreaterThanGreaterThanToken: return "thumb::asrs"
                case SK.GreaterThanGreaterThanGreaterThanToken: return "thumb::lsrs"
                // these could be compiled to branches butthis is more code-size efficient
                case SK.LessThanEqualsToken: return "Number_::le";
                case SK.LessThanToken: return "Number_::lt";
                case SK.GreaterThanEqualsToken: return "Number_::ge";
                case SK.GreaterThanToken: return "Number_::gt";
                case SK.EqualsEqualsToken:
                case SK.EqualsEqualsEqualsToken:
                    return "Number_::eq";
                case SK.ExclamationEqualsEqualsToken:
                case SK.ExclamationEqualsToken:
                    return "Number_::neq";

                default: return null;
            }

        }

        function emitBinaryExpression(node: BinaryExpression): ir.Expr {
            if (node.operatorToken.kind == SK.EqualsToken) {
                return handleAssignment(node);
            }

            let lt = typeOf(node.left)
            let rt = typeOf(node.right)

            let shim = (n: string) => rtcallMask(n, [node.left, node.right]);

            if (node.operatorToken.kind == SK.CommaToken) {
                if (isNoopExpr(node.left))
                    return emitExpr(node.right)
                else {
                    let v = emitIgnored(node.left)
                    return ir.op(EK.Sequence, [v, emitExpr(node.right)])
                }
            }

            if ((lt.flags & TypeFlags.Number) && (rt.flags & TypeFlags.Number)) {
                let noEq = stripEquals(node.operatorToken.kind)
                let shimName = simpleInstruction(noEq || node.operatorToken.kind)
                if (!shimName)
                    unhandled(node.operatorToken, lf("unsupported numeric operator"), 9250)
                if (noEq)
                    return emitIncrement(node.left, shimName, false, node.right)
                return shim(shimName)
            }

            if (node.operatorToken.kind == SK.PlusToken) {
                if ((lt.flags & TypeFlags.String) || (rt.flags & TypeFlags.String)) {
                    return ir.rtcallMask("String_::concat", 3, ir.CallingConvention.Plain, [
                        emitAsString(node.left),
                        emitAsString(node.right)])
                }
            }

            if (node.operatorToken.kind == SK.PlusEqualsToken &&
                (lt.flags & TypeFlags.String)) {

                let cleanup = prepForAssignment(node.left)
                let post = ir.shared(ir.rtcallMask("String_::concat", 3, ir.CallingConvention.Plain, [
                    emitExpr(node.left),
                    emitAsString(node.right)]))
                emitStore(node.left, irToNode(post))
                cleanup();
                return ir.op(EK.Incr, [post])
            }


            if ((lt.flags & TypeFlags.String) && (rt.flags & TypeFlags.String)) {
                switch (node.operatorToken.kind) {
                    case SK.LessThanEqualsToken:
                    case SK.LessThanToken:
                    case SK.GreaterThanEqualsToken:
                    case SK.GreaterThanToken:
                    case SK.EqualsEqualsToken:
                    case SK.EqualsEqualsEqualsToken:
                    case SK.ExclamationEqualsEqualsToken:
                    case SK.ExclamationEqualsToken:
                        return ir.rtcall(
                            simpleInstruction(node.operatorToken.kind),
                            [shim("String_::compare"), ir.numlit(0)])
                    default:
                        unhandled(node.operatorToken, lf("unknown string operator"), 9251)
                }
            }

            switch (node.operatorToken.kind) {
                case SK.EqualsEqualsToken:
                case SK.EqualsEqualsEqualsToken:
                    return shim("Number_::eq");
                case SK.ExclamationEqualsEqualsToken:
                case SK.ExclamationEqualsToken:
                    return shim("Number_::neq");
                case SK.BarBarToken:
                case SK.AmpersandAmpersandToken:
                    return emitLazyBinaryExpression(node);
                default:
                    throw unhandled(node.operatorToken, lf("unknown generic operator"), 9252)
            }
        }

        function emitAsString(e: Expression | TemplateLiteralFragment): ir.Expr {
            let r = emitExpr(e)
            // TS returns 'any' as type of template elements
            if (isStringLiteral(e))
                return r;
            let tp = typeOf(e)
            if (tp.flags & TypeFlags.Number)
                return ir.rtcall("Number_::toString", [r])
            else if (tp.flags & TypeFlags.Boolean)
                return ir.rtcall("Boolean_::toString", [r])
            else if (tp.flags & TypeFlags.String)
                return r // OK
            else
                throw userError(9225, lf("don't know how to convert to string"))
        }

        function emitConditionalExpression(node: ConditionalExpression) {
            let els = proc.mkLabel("condexprz")
            let fin = proc.mkLabel("condexprfin")
            // TODO what if the value is of ref type?
            proc.emitJmp(els, emitExpr(node.condition), ir.JmpMode.IfZero)
            proc.emitJmp(fin, emitExpr(node.whenTrue), ir.JmpMode.Always)
            proc.emitLbl(els)
            proc.emitJmp(fin, emitExpr(node.whenFalse), ir.JmpMode.Always)
            proc.emitLbl(fin)
            return ir.op(EK.JmpValue, [])
        }

        function emitSpreadElementExpression(node: SpreadElementExpression) { }
        function emitYieldExpression(node: YieldExpression) { }
        function emitBlock(node: Block) {
            node.statements.forEach(emit)
        }
        function emitVariableStatement(node: VariableStatement) {
            if (node.flags & NodeFlags.Ambient)
                return;
            node.declarationList.declarations.forEach(emit);
        }
        function emitExpressionStatement(node: ExpressionStatement) {
            emitExprAsStmt(node.expression)
        }
        function emitIfStatement(node: IfStatement) {
            emitBrk(node)
            let elseLbl = proc.mkLabel("else")
            proc.emitJmpZ(elseLbl, emitExpr(node.expression))
            emit(node.thenStatement)
            let afterAll = proc.mkLabel("afterif")
            proc.emitJmp(afterAll)
            proc.emitLbl(elseLbl)
            if (node.elseStatement)
                emit(node.elseStatement)
            proc.emitLbl(afterAll)
        }

        function getLabels(stmt: Node) {
            let id = getNodeId(stmt)
            return {
                fortop: ".fortop." + id,
                cont: ".cont." + id,
                brk: ".brk." + id,
                ret: ".ret." + id
            }
        }

        function emitDoStatement(node: DoStatement) {
            emitBrk(node)
            let l = getLabels(node)
            proc.emitLblDirect(l.cont);
            emit(node.statement)
            proc.emitJmpZ(l.brk, emitExpr(node.expression));
            proc.emitJmp(l.cont);
            proc.emitLblDirect(l.brk);
        }

        function emitWhileStatement(node: WhileStatement) {
            emitBrk(node)
            let l = getLabels(node)
            proc.emitLblDirect(l.cont);
            proc.emitJmpZ(l.brk, emitExpr(node.expression));
            emit(node.statement)
            proc.emitJmp(l.cont);
            proc.emitLblDirect(l.brk);
        }

        function isNoopExpr(node: Expression) {
            if (!node) return true;
            switch (node.kind) {
                case SK.Identifier:
                case SK.StringLiteral:
                case SK.NumericLiteral:
                case SK.NullKeyword:
                    return true; // no-op
            }
            return false
        }

        function emitIgnored(node: Expression) {
            let v = emitExpr(node);
            let a = typeOf(node)
            if (!(a.flags & TypeFlags.Void)) {
                if (isRefType(a)) {
                    // will pop
                    v = ir.op(EK.Decr, [v])
                }
            }
            return v
        }

        function emitExprAsStmt(node: Expression) {
            if (isNoopExpr(node)) return
            emitBrk(node)
            let v = emitIgnored(node)
            proc.emitExpr(v)
            proc.stackEmpty();
        }

        function emitForStatement(node: ForStatement) {
            if (node.initializer && node.initializer.kind == SK.VariableDeclarationList)
                (<VariableDeclarationList>node.initializer).declarations.forEach(emit);
            else
                emitExprAsStmt(<Expression>node.initializer);
            emitBrk(node)
            let l = getLabels(node)
            proc.emitLblDirect(l.fortop);
            if (node.condition)
                proc.emitJmpZ(l.brk, emitExpr(node.condition));
            emit(node.statement)
            proc.emitLblDirect(l.cont);
            emitExprAsStmt(node.incrementor);
            proc.emitJmp(l.fortop);
            proc.emitLblDirect(l.brk);
        }

        function emitForOfStatement(node: ForOfStatement) {
            if (!(node.initializer && node.initializer.kind == SK.VariableDeclarationList)) {
                unhandled(node, "only a single variable may be used to iterate a collection")
                return
            }

            let declList = <VariableDeclarationList>node.initializer;
            if (declList.declarations.length != 1) {
                unhandled(node, "only a single variable may be used to iterate a collection")
                return
            }

            //Typecheck the expression being iterated over
            let t = typeOf(node.expression)

            let indexer = ""
            let length = ""
            if (t.flags & TypeFlags.String) {
                indexer = "String_::charAt"
                length = "String_::length"
            }
            else if (isArrayType(t)) {
                indexer = "Array_::getAt"
                length = "Array_::length"
            }
            else {
                unhandled(node.expression, "cannot use for...of with this expression")
                return
            }

            //As the iterator isn't declared in the usual fashion we must mark it as used, otherwise no cell will be allocated for it 
            markUsed(declList.declarations[0])
            let iterVar = emitVariableDeclaration(declList.declarations[0]) // c
            //Start with null, TODO: Is this necessary
            proc.emitExpr(iterVar.storeByRef(ir.numlit(0)))
            proc.stackEmpty()

            // Store the expression (it could be a string literal, for example) for the collection being iterated over
            // Note that it's alaways a ref-counted type
            let collectionVar = proc.mkLocalUnnamed(true); // a
            proc.emitExpr(collectionVar.storeByRef(emitExpr(node.expression)))

            // Declaration of iterating variable
            let intVarIter = proc.mkLocalUnnamed(); // i
            proc.emitExpr(intVarIter.storeByRef(ir.numlit(0)))
            proc.stackEmpty();

            emitBrk(node);

            let l = getLabels(node);

            proc.emitLblDirect(l.fortop);
            // i < a.length()
            // we use loadCore() on collection variable so that it doesn't get incr()ed
            // we could have used load() and rtcallMask to be more regular
            proc.emitJmpZ(l.brk, ir.rtcall("Number_::lt", [intVarIter.load(), ir.rtcall(length, [collectionVar.loadCore()])]))

            // c = a[i]
            proc.emitExpr(iterVar.storeByRef(ir.rtcall(indexer, [collectionVar.loadCore(), intVarIter.load()])))

            emit(node.statement);
            proc.emitLblDirect(l.cont);

            // i = i + 1
            proc.emitExpr(intVarIter.storeByRef(ir.rtcall("thumb::adds", [intVarIter.load(), ir.numlit(1)])))

            proc.emitJmp(l.fortop);
            proc.emitLblDirect(l.brk);

            proc.emitExpr(collectionVar.storeByRef(ir.numlit(0))) // clear it, so it gets GCed
        }

        function emitForInOrForOfStatement(node: ForInStatement) { }

        function emitBreakOrContinueStatement(node: BreakOrContinueStatement) {
            emitBrk(node)
            let label = node.label ? node.label.text : null
            let isBreak = node.kind == SK.BreakStatement
            function findOuter(parent: Node): Statement {
                if (!parent) return null;
                if (label && parent.kind == SK.LabeledStatement &&
                    (<LabeledStatement>parent).label.text == label)
                    return (<LabeledStatement>parent).statement;
                if (parent.kind == SK.SwitchStatement && !label && isBreak)
                    return parent as Statement
                if (!label && isIterationStatement(parent, false))
                    return parent as Statement
                return findOuter(parent.parent);
            }
            let stmt = findOuter(node)
            if (!stmt)
                error(node, 9230, lf("cannot find outer loop"))
            else {
                let l = getLabels(stmt)
                if (node.kind == SK.ContinueStatement) {
                    if (!isIterationStatement(stmt, false))
                        error(node, 9231, lf("continue on non-loop"));
                    else proc.emitJmp(l.cont)
                } else if (node.kind == SK.BreakStatement) {
                    proc.emitJmp(l.brk)
                } else {
                    oops();
                }
            }
        }

        function emitReturnStatement(node: ReturnStatement) {
            emitBrk(node)
            let v: ir.Expr = null
            if (node.expression) {
                v = emitExpr(node.expression)
            } else if (funcHasReturn(proc.action)) {
                v = ir.numlit(null) // == return undefined
            }
            proc.emitJmp(getLabels(proc.action).ret, v, ir.JmpMode.Always)
        }

        function emitWithStatement(node: WithStatement) { }

        function emitSwitchStatement(node: SwitchStatement) {
            emitBrk(node)
            if (!(typeOf(node.expression).flags & (TypeFlags.Number | TypeFlags.Enum))) {
                userError(9226, lf("switch() only supported over numbers or enums"))
            }

            let l = getLabels(node)
            let hasDefault = false
            let expr = emitExpr(node.expression)
            emitInJmpValue(expr)
            let lbls = node.caseBlock.clauses.map(cl => {
                let lbl = proc.mkLabel("switch")
                if (cl.kind == SK.CaseClause) {
                    let cc = cl as CaseClause
                    proc.emitJmp(lbl, emitExpr(cc.expression), ir.JmpMode.IfJmpValEq)
                } else {
                    hasDefault = true
                    proc.emitJmp(lbl)
                }
                return lbl
            })
            if (!hasDefault)
                proc.emitJmp(l.brk);

            node.caseBlock.clauses.forEach((cl, i) => {
                proc.emitLbl(lbls[i])
                cl.statements.forEach(emit)
            })

            proc.emitLblDirect(l.brk);
        }

        function emitCaseOrDefaultClause(node: CaseOrDefaultClause) { }
        function emitLabeledStatement(node: LabeledStatement) {
            let l = getLabels(node.statement)
            emit(node.statement)
            proc.emitLblDirect(l.brk)
        }
        function emitThrowStatement(node: ThrowStatement) { }
        function emitTryStatement(node: TryStatement) { }
        function emitCatchClause(node: CatchClause) { }
        function emitDebuggerStatement(node: Node) {
            emitBrk(node)
        }
        function emitVariableDeclaration(node: VarOrParam): ir.Cell {
            typeCheckVar(node)
            if (!isUsed(node)) {
                return null;
            }
            let loc = isGlobalVar(node) ?
                lookupCell(node) : proc.mkLocal(node, getVarInfo(node))
            if (loc.isByRefLocal()) {
                proc.emitClrIfRef(loc) // we might be in a loop
                proc.emitExpr(loc.storeDirect(ir.rtcall("pxtrt::mkloc" + loc.refSuffix(), [])))
            }
            // TODO make sure we don't emit code for top-level globals being initialized to zero
            if (node.initializer) {
                emitBrk(node)
                proc.emitExpr(loc.storeByRef(emitExpr(node.initializer)))
                proc.stackEmpty();
            }
            return loc;
        }

        function emitClassExpression(node: ClassExpression) { }
        function emitClassDeclaration(node: ClassDeclaration) {
            //if (node.typeParameters)
            //    userError(9227, lf("generic classes not supported"))
            if (node.heritageClauses)
                userError(9228, lf("inheritance not supported"))
            node.members.forEach(emit)
        }
        function emitInterfaceDeclaration(node: InterfaceDeclaration) {
            //userError(9228, lf("interfaces are not currently supported"))
        }
        function emitEnumDeclaration(node: EnumDeclaration) {
            //No code needs to be generated, enum names are replaced by constant values in generated code
        }
        function emitEnumMember(node: EnumMember) { }
        function emitModuleDeclaration(node: ModuleDeclaration) {
            if (node.flags & NodeFlags.Ambient)
                return;
            emit(node.body);
        }
        function emitImportDeclaration(node: ImportDeclaration) { }
        function emitImportEqualsDeclaration(node: ImportEqualsDeclaration) { }
        function emitExportDeclaration(node: ExportDeclaration) { }
        function emitExportAssignment(node: ExportAssignment) { }
        function emitSourceFileNode(node: SourceFile) {
            node.statements.forEach(emit)
        }

        function catchErrors<T>(node: Node, f: (node: Node) => T): T {
            let prevErr = lastSecondaryError
            inCatchErrors++
            try {
                lastSecondaryError = null
                let res = f(node)
                if (lastSecondaryError)
                    userError(lastSecondaryErrorCode, lastSecondaryError)
                lastSecondaryError = prevErr
                inCatchErrors--
                return res
            } catch (e) {
                inCatchErrors--
                lastSecondaryError = null
                if (!e.ksEmitterUserError)
                    console.log(e.stack)
                let code = e.ksErrorCode || 9200
                error(node, code, e.message)
                return null
            }
        }

        function emitExpr(node0: Node): ir.Expr {
            let node = node0 as NodeWithCache
            if (node.cachedIR) {
                if (isRefCountedExpr(node0 as Expression))
                    return ir.op(EK.Incr, [node.cachedIR])
                return node.cachedIR
            }
            let res = catchErrors(node, emitExprInner) || ir.numlit(0)
            if (node.needsIRCache) {
                node.cachedIR = ir.shared(res)
                return node.cachedIR
            }
            return res
        }

        function emitExprInner(node: Node): ir.Expr {
            let expr = emitExprCore(node);
            if (expr.isExpr()) return expr
            throw new Error("expecting expression")
        }

        function emit(node: Node): void {
            catchErrors(node, emitNodeCore)
        }

        function emitNodeCore(node: Node): void {
            switch (node.kind) {
                case SK.SourceFile:
                    return emitSourceFileNode(<SourceFile>node);
                case SK.InterfaceDeclaration:
                    return emitInterfaceDeclaration(<InterfaceDeclaration>node);
                case SK.VariableStatement:
                    return emitVariableStatement(<VariableStatement>node);
                case SK.ModuleDeclaration:
                    return emitModuleDeclaration(<ModuleDeclaration>node);
                case SK.EnumDeclaration:
                    return emitEnumDeclaration(<EnumDeclaration>node);
                //case SyntaxKind.MethodSignature:
                case SK.FunctionDeclaration:
                case SK.Constructor:
                case SK.MethodDeclaration:
                    emitFunctionDeclaration(<FunctionLikeDeclaration>node);
                    return
                case SK.ExpressionStatement:
                    return emitExpressionStatement(<ExpressionStatement>node);
                case SK.Block:
                case SK.ModuleBlock:
                    return emitBlock(<Block>node);
                case SK.VariableDeclaration:
                    emitVariableDeclaration(<VariableDeclaration>node);
                    return
                case SK.IfStatement:
                    return emitIfStatement(<IfStatement>node);
                case SK.WhileStatement:
                    return emitWhileStatement(<WhileStatement>node);
                case SK.DoStatement:
                    return emitDoStatement(<DoStatement>node);
                case SK.ForStatement:
                    return emitForStatement(<ForStatement>node);
                case SK.ForOfStatement:
                    return emitForOfStatement(<ForOfStatement>node);
                case SK.ContinueStatement:
                case SK.BreakStatement:
                    return emitBreakOrContinueStatement(<BreakOrContinueStatement>node);
                case SK.LabeledStatement:
                    return emitLabeledStatement(<LabeledStatement>node);
                case SK.ReturnStatement:
                    return emitReturnStatement(<ReturnStatement>node);
                case SK.ClassDeclaration:
                    return emitClassDeclaration(<ClassDeclaration>node);
                case SK.PropertyDeclaration:
                case SK.PropertyAssignment:
                    return emitPropertyAssignment(<PropertyDeclaration>node);
                case SK.SwitchStatement:
                    return emitSwitchStatement(<SwitchStatement>node);
                case SK.TypeAliasDeclaration:
                    // skip
                    return
                case SK.DebuggerStatement:
                    return emitDebuggerStatement(node);
                case SK.GetAccessor:
                case SK.SetAccessor:
                    return emitAccessor(<AccessorDeclaration>node);
                default:
                    unhandled(node);
            }
        }

        function emitExprCore(node: Node): ir.Expr {
            switch (node.kind) {
                case SK.NullKeyword:
                    let v = (node as any).valueOverride;
                    if (v) return v
                    return ir.numlit(null);
                case SK.TrueKeyword:
                    return ir.numlit(true);
                case SK.FalseKeyword:
                    return ir.numlit(false);
                case SK.TemplateHead:
                case SK.TemplateMiddle:
                case SK.TemplateTail:
                case SK.NumericLiteral:
                case SK.StringLiteral:
                case SK.NoSubstitutionTemplateLiteral:
                    //case SyntaxKind.RegularExpressionLiteral:                    
                    return emitLiteral(<LiteralExpression>node);
                case SK.PropertyAccessExpression:
                    return emitPropertyAccess(<PropertyAccessExpression>node);
                case SK.BinaryExpression:
                    return emitBinaryExpression(<BinaryExpression>node);
                case SK.PrefixUnaryExpression:
                    return emitPrefixUnaryExpression(<PrefixUnaryExpression>node);
                case SK.PostfixUnaryExpression:
                    return emitPostfixUnaryExpression(<PostfixUnaryExpression>node);
                case SK.ElementAccessExpression:
                    return emitIndexedAccess(<ElementAccessExpression>node);
                case SK.ParenthesizedExpression:
                    return emitParenExpression(<ParenthesizedExpression>node);
                case SK.TypeAssertionExpression:
                    return emitTypeAssertion(<TypeAssertion>node);
                case SK.ArrayLiteralExpression:
                    return emitArrayLiteral(<ArrayLiteralExpression>node);
                case SK.NewExpression:
                    return emitNewExpression(<NewExpression>node);
                case SK.ThisKeyword:
                    return emitThis(node);
                case SK.CallExpression:
                    return emitCallExpression(<CallExpression>node);
                case SK.FunctionExpression:
                case SK.ArrowFunction:
                    return emitFunctionDeclaration(<FunctionLikeDeclaration>node);
                case SK.Identifier:
                    return emitIdentifier(<Identifier>node);
                case SK.ConditionalExpression:
                    return emitConditionalExpression(<ConditionalExpression>node);
                case SK.AsExpression:
                    return emitAsExpression(<AsExpression>node);
                case SyntaxKind.TemplateExpression:
                    return emitTemplateExpression(<TemplateExpression>node);

                default:
                    unhandled(node);
                    return null

                /*    
                case SyntaxKind.TemplateSpan:
                    return emitTemplateSpan(<TemplateSpan>node);
                case SyntaxKind.Parameter:
                    return emitParameter(<ParameterDeclaration>node);
                case SyntaxKind.SuperKeyword:
                    return emitSuper(node);
                case SyntaxKind.JsxElement:
                    return emitJsxElement(<JsxElement>node);
                case SyntaxKind.JsxSelfClosingElement:
                    return emitJsxSelfClosingElement(<JsxSelfClosingElement>node);
                case SyntaxKind.JsxText:
                    return emitJsxText(<JsxText>node);
                case SyntaxKind.JsxExpression:
                    return emitJsxExpression(<JsxExpression>node);
                case SyntaxKind.QualifiedName:
                    return emitQualifiedName(<QualifiedName>node);
                case SyntaxKind.ObjectBindingPattern:
                    return emitObjectBindingPattern(<BindingPattern>node);
                case SyntaxKind.ArrayBindingPattern:
                    return emitArrayBindingPattern(<BindingPattern>node);
                case SyntaxKind.BindingElement:
                    return emitBindingElement(<BindingElement>node);
                case SyntaxKind.ObjectLiteralExpression:
                    return emitObjectLiteral(<ObjectLiteralExpression>node);
                case SyntaxKind.ShorthandPropertyAssignment:
                    return emitShorthandPropertyAssignment(<ShorthandPropertyAssignment>node);
                case SyntaxKind.ComputedPropertyName:
                    return emitComputedPropertyName(<ComputedPropertyName>node);
                case SyntaxKind.TaggedTemplateExpression:
                    return emitTaggedTemplateExpression(<TaggedTemplateExpression>node);
                case SyntaxKind.DeleteExpression:
                    return emitDeleteExpression(<DeleteExpression>node);
                case SyntaxKind.TypeOfExpression:
                    return emitTypeOfExpression(<TypeOfExpression>node);
                case SyntaxKind.VoidExpression:
                    return emitVoidExpression(<VoidExpression>node);
                case SyntaxKind.AwaitExpression:
                    return emitAwaitExpression(<AwaitExpression>node);
                case SyntaxKind.SpreadElementExpression:
                    return emitSpreadElementExpression(<SpreadElementExpression>node);
                case SyntaxKind.YieldExpression:
                    return emitYieldExpression(<YieldExpression>node);
                case SyntaxKind.OmittedExpression:
                    return;
                case SyntaxKind.EmptyStatement:
                    return;
                case SyntaxKind.ForOfStatement:
                case SyntaxKind.ForInStatement:
                    return emitForInOrForOfStatement(<ForInStatement>node);
                case SyntaxKind.WithStatement:
                    return emitWithStatement(<WithStatement>node);
                case SyntaxKind.CaseClause:
                case SyntaxKind.DefaultClause:
                    return emitCaseOrDefaultClause(<CaseOrDefaultClause>node);
                case SyntaxKind.ThrowStatement:
                    return emitThrowStatement(<ThrowStatement>node);
                case SyntaxKind.TryStatement:
                    return emitTryStatement(<TryStatement>node);
                case SyntaxKind.CatchClause:
                    return emitCatchClause(<CatchClause>node);
                case SyntaxKind.ClassExpression:
                    return emitClassExpression(<ClassExpression>node);
                case SyntaxKind.EnumMember:
                    return emitEnumMember(<EnumMember>node);
                case SyntaxKind.ImportDeclaration:
                    return emitImportDeclaration(<ImportDeclaration>node);
                case SyntaxKind.ImportEqualsDeclaration:
                    return emitImportEqualsDeclaration(<ImportEqualsDeclaration>node);
                case SyntaxKind.ExportDeclaration:
                    return emitExportDeclaration(<ExportDeclaration>node);
                case SyntaxKind.ExportAssignment:
                    return emitExportAssignment(<ExportAssignment>node);
                */
            }
        }
    }

    export interface FuncInfo {
        name: string;
        type: string;
        args: number;
        value: number;
    }

    export interface YottaConfig {
        dependencies?: U.Map<string>;
        config?: any;
        configIsJustDefaults?: boolean;
        ignoreConflicts?: boolean;
    }

    export interface ExtensionInfo {
        functions: FuncInfo[];
        generatedFiles: U.Map<string>;
        extensionFiles: U.Map<string>;
        yotta: YottaConfig;
        sha: string;
        compileData: string;
        shimsDTS: string;
        enumsDTS: string;
        onlyPublic: boolean;
    }

    export function emptyExtInfo(): ExtensionInfo {
        return {
            functions: [],
            generatedFiles: {},
            extensionFiles: {},
            sha: "",
            compileData: "",
            shimsDTS: "",
            enumsDTS: "",
            onlyPublic: true,
            yotta: {
                dependencies: {},
                config: {}
            }
        }
    }


    export class Binary {
        procs: ir.Procedure[] = [];
        globals: ir.Cell[] = [];
        finalPass = false;
        target: CompileTarget;
        writeFile = (fn: string, cont: string) => { };
        res: CompileResult;

        strings: StringMap<string> = {};
        otherLiterals: string[] = [];
        lblNo = 0;

        isDataRecord(s: string) {
            if (!s) return false
            let m = /^:......(..)/.exec(s)
            assert(!!m)
            return m[1] == "00"
        }

        addProc(proc: ir.Procedure) {
            this.procs.push(proc)
            proc.seqNo = this.procs.length
            //proc.binary = this
        }

        emitString(s: string): string {
            if (this.strings.hasOwnProperty(s))
                return this.strings[s]
            let lbl = "_str" + this.lblNo++
            this.strings[s] = lbl;
            return lbl
        }
    }
}

