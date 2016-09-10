namespace ts.pxtc {
    export var decodeBase64 = function (s: string) { return atob(s); }
    interface BitSizeInfo {
        size: number;
        ldr: string;
        str: string;
        needsSignExt?: boolean;
        immLimit: number;
    }

    const vtableShift = 2;

    function irToAssembly(bin: Binary, proc: ir.Procedure) {
        let resText = ""
        let write = (s: string) => { resText += asmline(s); }
        let EK = ir.EK;

        write(`
;
; Function ${proc.getName()}
;
`)

        if (proc.args.length <= 3)
            emitLambdaWrapper(proc.isRoot)

        let baseLabel = proc.label()
        let bkptLabel = baseLabel + "_bkpt"
        let locLabel = baseLabel + "_locals"
        write(`
.section code
${bkptLabel}:
    bkpt 1
${baseLabel}:
    @stackmark func
    @stackmark args
    push {lr}
`)

        let calls: ProcCallInfo[] = []
        proc.fillDebugInfo = th => {
            let labels = th.getLabels()

            proc.debugInfo = {
                locals: (proc.seqNo == 1 ? bin.globals : proc.locals).map(l => l.getDebugInfo()),
                args: proc.args.map(l => l.getDebugInfo()),
                name: proc.getName(),
                codeStartLoc: U.lookup(labels, bkptLabel + "_after"),
                bkptLoc: U.lookup(labels, bkptLabel),
                localsMark: U.lookup(th.stackAtLabel, locLabel),
                idx: proc.seqNo,
                calls: calls
            }

            for (let ci of calls) {
                ci.addr = U.lookup(labels, ci.callLabel)
                ci.stack = U.lookup(th.stackAtLabel, ci.callLabel)
                ci.callLabel = undefined // don't waste space
            }

            for (let i = 0; i < proc.body.length; ++i) {
                let bi = proc.body[i].breakpointInfo
                if (bi) {
                    let off = U.lookup(th.stackAtLabel, `__brkp_${bi.id}`)
                    assert(off === proc.debugInfo.localsMark)
                }
            }
        }

        let numlocals = proc.locals.length
        if (numlocals > 0) write("movs r0, #0")
        proc.locals.forEach(l => {
            write("push {r0} ; loc")
        })
        write("@stackmark locals")
        write(`${locLabel}:`)

        //console.log(proc.toString())
        proc.resolve()
        //console.log("OPT", proc.toString())

        // debugger hook - bit #1 of global #0 determines break on function entry
        // we could have put the 'bkpt' inline, and used `bpl`, but that would be 2 cycles slower
        write(`
    ldr r0, [r6, #0]
    lsls r0, r0, #30
    bmi ${bkptLabel}
${bkptLabel + "_after"}:
`)

        let exprStack: ir.Expr[] = []

        for (let i = 0; i < proc.body.length; ++i) {
            let s = proc.body[i]
            // console.log("STMT", s.toString())
            switch (s.stmtKind) {
                case ir.SK.Expr:
                    emitExpr(s.expr)
                    break;
                case ir.SK.StackEmpty:
                    if (exprStack.length > 0) {
                        for (let stmt of proc.body.slice(i - 4, i + 1))
                            console.log(`PREVSTMT ${stmt.toString().trim()}`)
                        for (let e of exprStack)
                            console.log(`EXPRSTACK ${e.currUses}/${e.totalUses} E: ${e.toString()}`)
                        oops("stack should be empty")
                    }
                    write("@stackempty locals")
                    break;
                case ir.SK.Jmp:
                    emitJmp(s);
                    break;
                case ir.SK.Label:
                    write(s.lblName + ":")
                    break;
                case ir.SK.Breakpoint:
                    write(`__brkp_${s.breakpointInfo.id}:`)
                    if (s.breakpointInfo.isDebuggerStmt) {
                        let lbl = mkLbl("debugger")
                        // bit #0 of debugger register is set when debugger is attached
                        write("ldr r0, [r6, #0]")
                        write("lsls r0, r0, #31")
                        write(`bpl ${lbl}`)
                        write(`bkpt 2`)
                        write(`${lbl}:`)
                    } else {
                        // do nothing
                    }
                    break;
                default: oops();
            }
        }

        assert(0 <= numlocals && numlocals < 127);
        if (numlocals > 0)
            write("add sp, #4*" + numlocals + " ; pop locals " + numlocals)
        write("pop {pc}");
        write("@stackempty func");
        write("@stackempty args")

        return resText

        function mkLbl(root: string) {
            return "." + root + bin.lblNo++
        }

        function terminate(expr: ir.Expr) {
            assert(expr.exprKind == ir.EK.SharedRef)
            let arg = expr.args[0]
            if (arg.currUses == arg.totalUses)
                return
            let numEntries = 0
            while (numEntries < exprStack.length) {
                let ee = exprStack[numEntries]
                if (ee != arg && ee.currUses != ee.totalUses)
                    break
                numEntries++
            }
            assert(numEntries > 0)
            write(`@dummystack ${numEntries}`)
            write(`add sp, #4*${numEntries} ; terminate ref`)
        }

        function emitJmp(jmp: ir.Stmt) {
            if (jmp.jmpMode == ir.JmpMode.Always) {
                if (jmp.expr)
                    emitExpr(jmp.expr)
                if (jmp.terminateExpr)
                    terminate(jmp.terminateExpr)
                write("bb " + jmp.lblName + " ; with expression")
            } else {
                let lbl = mkLbl("jmpz")

                if (jmp.jmpMode == ir.JmpMode.IfJmpValEq) {
                    emitExprInto(jmp.expr, "r1")
                    write("cmp r0, r1")
                } else {
                    emitExpr(jmp.expr)

                    if (jmp.expr.exprKind == EK.RuntimeCall && jmp.expr.data === "thumb::subs") {
                        // no cmp required
                    } else {
                        write("cmp r0, #0")
                    }
                }

                if (jmp.jmpMode == ir.JmpMode.IfNotZero) {
                    write("beq " + lbl) // this is to *skip* the following 'b' instruction; beq itself has a very short range
                } else {
                    // IfZero or IfJmpValEq
                    write("bne " + lbl)
                }

                if (jmp.terminateExpr)
                    terminate(jmp.terminateExpr)

                write("bb " + jmp.lblName)
                write(lbl + ":")
            }
        }

        function clearStack() {
            let numEntries = 0
            while (exprStack.length > 0 && exprStack[0].currUses == exprStack[0].totalUses) {
                numEntries++;
                exprStack.shift()
            }
            if (numEntries)
                write("add sp, #4*" + numEntries + " ; clear stack")
        }

        function withRef(name: string, isRef: boolean) {
            return name + (isRef ? "Ref" : "")
        }

        function emitExprInto(e: ir.Expr, reg: string) {
            switch (e.exprKind) {
                case EK.NumberLiteral:
                    if (e.data === true) emitInt(1, reg);
                    else if (e.data === false) emitInt(0, reg);
                    else if (e.data === null) emitInt(0, reg);
                    else if (typeof e.data == "number") emitInt(e.data, reg)
                    else oops();
                    break;
                case EK.PointerLiteral:
                    emitLdPtr(e.data, reg);
                    break;
                case EK.SharedRef:
                    let arg = e.args[0]
                    U.assert(!!arg.currUses) // not first use
                    U.assert(arg.currUses < arg.totalUses)
                    arg.currUses++
                    let idx = exprStack.indexOf(arg)
                    U.assert(idx >= 0)
                    if (idx == 0 && arg.totalUses == arg.currUses) {
                        write(`pop {${reg}}  ; tmpref @${exprStack.length}`)
                        exprStack.shift()
                        clearStack()
                    } else {
                        write(`ldr ${reg}, [sp, #4*${idx}]   ; tmpref @${exprStack.length - idx}`)
                    }
                    break;
                case EK.CellRef:
                    let cell = e.data as ir.Cell
                    if (cell.isGlobal()) {
                        let inf = bitSizeInfo(cell.bitSize)
                        let off = "#" + cell.index
                        if (inf.needsSignExt || cell.index >= inf.immLimit) {
                            emitInt(cell.index, reg)
                            off = reg
                        }
                        write(`${inf.ldr} ${reg}, [r6, ${off}]`)
                    } else {
                        write(`ldr ${reg}, ${cellref(cell)}`)
                    }
                    break;
                default: oops();
            }
        }

        function bitSizeInfo(b: BitSize) {
            let inf: BitSizeInfo = {
                size: sizeOfBitSize(b),
                ldr: "",
                str: "",
                immLimit: 128
            }
            if (inf.size == 1) {
                inf.immLimit = 32
                inf.str = "strb"
            } else if (inf.size == 2) {
                inf.immLimit = 64
                inf.str = "strh"
            } else {
                inf.str = "str"
            }
            if (b == BitSize.Int8 || b == BitSize.Int16) {
                inf.needsSignExt = true
                inf.ldr = inf.str.replace("str", "ldrs")
            } else {
                inf.ldr = inf.str.replace("str", "ldr")
            }
            return inf
        }

        // result in R0
        function emitExpr(e: ir.Expr): void {
            //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)

            switch (e.exprKind) {
                case EK.JmpValue:
                    write("; jmp value (already in r0)")
                    break;
                case EK.Nop:
                    // this is there because we need different addresses for breakpoints
                    write("nop")
                    break;
                case EK.Incr:
                    emitExpr(e.args[0])
                    emitCallRaw("pxt::incr")
                    break;
                case EK.Decr:
                    emitExpr(e.args[0])
                    emitCallRaw("pxt::decr")
                    break;
                case EK.FieldAccess:
                    let info = e.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    return emitExpr(ir.rtcall(withRef("pxtrt::ldfld", info.isRef), [e.args[0], ir.numlit(info.idx)]))
                case EK.Store:
                    return emitStore(e.args[0], e.args[1])
                case EK.RuntimeCall:
                    return emitRtCall(e);
                case EK.ProcCall:
                    return emitProcCall(e)
                case EK.SharedDef:
                    return emitSharedDef(e)
                case EK.Sequence:
                    e.args.forEach(emitExpr)
                    return clearStack()
                default:
                    return emitExprInto(e, "r0")
            }
        }

        function emitSharedDef(e: ir.Expr) {
            let arg = e.args[0]
            U.assert(arg.totalUses >= 1)
            U.assert(arg.currUses === 0)
            arg.currUses = 1
            if (arg.totalUses == 1)
                return emitExpr(arg)
            else {
                emitExpr(arg)
                exprStack.unshift(arg)
                write("push {r0} ; tmpstore @" + exprStack.length)
            }
        }

        function emitSharedTerminate(e: ir.Expr) {
            emitExpr(e)
            let arg = e.data as ir.Expr

        }

        function emitRtCall(topExpr: ir.Expr) {
            let info = ir.flattenArgs(topExpr)

            info.precomp.forEach(emitExpr)
            info.flattened.forEach((a, i) => {
                U.assert(i <= 3)
                emitExprInto(a, "r" + i)
            })

            clearStack()

            let name: string = topExpr.data
            //console.log("RT",name,topExpr.isAsync)

            if (name == "thumb::ignore")
                return

            if (U.startsWith(name, "thumb::")) {
                write(`${name.slice(7)} r0, r1`)
            } else {
                write(`bl ${name}`)
            }
        }

        function emitHelper(asm: string) {
            if (!bin.codeHelpers[asm]) {
                let len = Object.keys(bin.codeHelpers).length
                bin.codeHelpers[asm] = "_hlp_" + len
            }
            write(`bl ${bin.codeHelpers[asm]}`)
        }

        function emitProcCall(topExpr: ir.Expr) {
            let stackBottom = 0
            //console.log("PROCCALL", topExpr.toString())
            let argStmts = topExpr.args.map((a, i) => {
                emitExpr(a)
                write("push {r0} ; proc-arg")
                a.totalUses = 1
                a.currUses = 0
                exprStack.unshift(a)
                if (i == 0) stackBottom = exprStack.length
                U.assert(exprStack.length - stackBottom == i)
                return a
            })

            let lbl = mkLbl("proccall")
            let afterall = mkLbl("afterall")

            let procid = topExpr.data as ir.ProcId
            let procIdx = -1
            if (procid.virtualIndex != null || procid.ifaceIndex != null) {
                if (procid.mapMethod) {
                    let isSet = /Set/.test(procid.mapMethod)
                    assert(isSet == (topExpr.args.length == 2))
                    assert(!isSet == (topExpr.args.length == 1))
                    emitInt(procid.mapIdx, "r1")
                    if (isSet)
                        emitInt(procid.ifaceIndex, "r2")
                    write(lbl + ":")
                    emitHelper(`
        ldr r0, [sp, #${isSet ? 4 : 0}] ; ld-this
        ldrh r3, [r0, #2] ; ld-vtable
        lsls r3, r3, #${vtableShift}
        ldr r3, [r3, #4] ; iface table
        cmp r3, #43
        beq .objlit
.nonlit:
        lsls r1, ${isSet ? "r2" : "r1"}, #2
        ldr r0, [r3, r1] ; ld-method
        bx r0
.objlit:
        ${isSet ? "ldr r2, [sp, #0]" : ""}
        push {lr}
        bl ${procid.mapMethod}
        pop {pc}
`);
                } else {
                    write(`ldr r0, [sp, #4*${topExpr.args.length - 1}]  ; ld-this`)
                    write(`ldrh r0, [r0, #2] ; ld-vtable`)
                    write(`lsls r0, r0, #${vtableShift}`)
                    let effIdx = procid.virtualIndex + 4
                    if (procid.ifaceIndex != null) {
                        write(`ldr r0, [r0, #4] ; iface table`)
                        effIdx = procid.ifaceIndex
                    }
                    if (effIdx <= 31)
                        write(`ldr r0, [r0, #4*${effIdx}] ; ld-method`)
                    else {
                        emitInt(effIdx * 4, "r1")
                        write(`ldr r0, [r0, r1] ; ld-method`)
                    }
                    write(lbl + ":")
                    write("blx r0")
                    write(afterall + ":")
                }
            } else {
                let proc = procid.proc
                procIdx = proc.seqNo
                write(lbl + ":")
                write("bl " + proc.label())
            }
            calls.push({
                procIndex: procIdx,
                stack: 0,
                addr: 0,
                callLabel: lbl,
            })
            for (let a of argStmts) {
                a.currUses = 1
            }
            clearStack()
        }

        function emitStore(trg: ir.Expr, src: ir.Expr) {
            switch (trg.exprKind) {
                case EK.CellRef:
                    let cell = trg.data as ir.Cell
                    emitExpr(src)
                    if (cell.isGlobal()) {
                        let inf = bitSizeInfo(cell.bitSize)
                        let off = "#" + cell.index
                        if (cell.index >= inf.immLimit) {
                            emitInt(cell.index, "r1")
                            off = "r1"
                        }
                        write(`${inf.str} r0, [r6, ${off}]`)
                    } else {
                        write("str r0, " + cellref(cell))
                    }
                    break;
                case EK.FieldAccess:
                    let info = trg.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    emitExpr(ir.rtcall(withRef("pxtrt::stfld", info.isRef), [trg.args[0], ir.numlit(info.idx), src]))
                    break;
                default: oops();
            }
        }

        function cellref(cell: ir.Cell) {
            if (cell.isGlobal()) {
                throw oops()
            } else if (cell.iscap) {
                assert(0 <= cell.index && cell.index < 32)
                return "[r5, #4*" + cell.index + "]"
            } else if (cell.isarg) {
                let idx = proc.args.length - cell.index - 1
                return "[sp, args@" + idx + "] ; " + cell.toString()
            } else {
                return "[sp, locals@" + cell.index + "] ; " + cell.toString()
            }
        }

        function emitLambdaWrapper(isMain: boolean) {
            let node = proc.action
            write("")
            write(".section code");
            if (isMain)
                write("b .themain")
            write(".balign 4");
            write(proc.label() + "_Lit:");
            write(".short 0xffff, 0x0000   ; action literal");
            write("@stackmark litfunc");
            if (isMain)
                write(".themain:")
            let parms = proc.args.map(a => a.def)
            if (parms.length >= 1)
                write("push {r1, r5, r6, lr}");
            else
                write("push {r5, r6, lr}");


            parms.forEach((_, i) => {
                if (i >= 3)
                    U.userError(U.lf("only up to three parameters supported in lambdas"))
                if (i > 0) // r1 already done
                    write(`push {r${i + 1}}`)
            })

            let asm = `
    @stackmark args
    push {lr}
    mov r5, r0
`;

            proc.args.forEach((p, i) => {
                if (p.isRef()) {
                    asm += `    ldr r0, ${cellref(p).replace(/;.*/, "")}\n`
                    asm += `    bl pxt::incr\n`
                }
            })

            asm += `
    bl pxtrt::getGlobalsPtr
    mov r6, r0
    pop {pc}
    @stackempty args
`

            emitHelper(asm) // using shared helper saves about 3% of binary size
            write(`bl ${proc.label()}`)

            if (parms.length)
                write("add sp, #4*" + parms.length + " ; pop args")
            write("pop {r5, r6, pc}");
            write("@stackempty litfunc");
        }

        function emitCallRaw(name: string) {
            let inf = hex.lookupFunc(name)
            assert(!!inf, "unimplemented raw function: " + name)
            write("bl " + name + " ; *" + inf.type + inf.args + " (raw)")
        }

        function emitLdPtr(lbl: string, reg: string) {
            assert(!!lbl)
            write(`movs ${reg}, ${lbl}@hi  ; ldptr`)
            write(`lsls ${reg}, ${reg}, #8`)
            write(`adds ${reg}, ${lbl}@lo`);
        }

        function numBytes(n: number) {
            let v = 0
            for (let q = n; q > 0; q >>>= 8) {
                v++
            }
            return v || 1
        }

        function emitInt(v: number, reg: string) {
            let movWritten = false

            function writeMov(v: number) {
                assert(0 <= v && v <= 255)
                if (movWritten) {
                    if (v)
                        write(`adds ${reg}, #${v}`)
                } else
                    write(`movs ${reg}, #${v}`)
                movWritten = true
            }

            function shift(v = 8) {
                write(`lsls ${reg}, ${reg}, #${v}`)
            }

            assert(v != null);

            let n = Math.floor(v)
            let isNeg = false
            if (n < 0) {
                isNeg = true
                n = -n
            }

            let numShift = 0
            if (n > 0xff) {
                let shifted = n
                while ((shifted & 1) == 0) {
                    shifted >>>= 1
                    numShift++
                }
                if (numBytes(shifted) < numBytes(n)) {
                    n = shifted
                } else {
                    numShift = 0
                }
            }


            switch (numBytes(n)) {
                case 4:
                    writeMov((n >>> 24) & 0xff)
                    shift()
                case 3:
                    writeMov((n >>> 16) & 0xff)
                    shift()
                case 2:
                    writeMov((n >>> 8) & 0xff)
                    shift()
                case 1:
                    writeMov(n & 0xff)
                    break
                default:
                    oops()
            }

            if (numShift)
                shift(numShift)

            if (isNeg) {
                write(`negs ${reg}, ${reg}`)
            }
        }


    }

    // TODO should be internal
    export namespace hex {
        let funcInfo: Map<FuncInfo>;
        let hex: string[];
        let jmpStartAddr: number;
        let jmpStartIdx: number;
        let bytecodePaddingSize: number;
        let bytecodeStartAddr: number;
        export let bytecodeStartAddrPadded: number;
        let bytecodeStartIdx: number;
        let asmLabels: Map<boolean> = {};
        export let asmTotalSource: string = "";
        export const pageSize = 0x400;

        function swapBytes(str: string) {
            let r = ""
            let i = 0
            for (; i < str.length; i += 2)
                r = str[i] + str[i + 1] + r
            assert(i == str.length)
            return r
        }

        export function setupInlineAssembly(opts: CompileOptions) {
            asmLabels = {}
            let asmSources = opts.sourceFiles.filter(f => U.endsWith(f, ".asm"))
            asmTotalSource = ""
            let asmIdx = 0

            for (let f of asmSources) {
                let src = opts.fileSystem[f]
                src.replace(/^\s*(\w+):/mg, (f, lbl) => {
                    asmLabels[lbl] = true
                    return ""
                })
                let code =
                    ".section code\n" +
                    "@stackmark func\n" +
                    "@scope user" + asmIdx++ + "\n" +
                    src + "\n" +
                    "@stackempty func\n" +
                    "@scope\n"
                asmTotalSource += code
            }
        }


        export function isSetupFor(extInfo: ExtensionInfo) {
            return currentSetup == extInfo.sha
        }

        function parseHexBytes(bytes: string): number[] {
            bytes = bytes.replace(/^[\s:]/, "")
            if (!bytes) return []
            let m = /^([a-f0-9][a-f0-9])/i.exec(bytes)
            if (m)
                return [parseInt(m[1], 16)].concat(parseHexBytes(bytes.slice(2)))
            else
                throw oops("bad bytes " + bytes)
        }

        let currentSetup: string = null;
        export let currentHexInfo: any;

        export function setupFor(extInfo: ExtensionInfo, hexinfo: any) {
            if (isSetupFor(extInfo))
                return;

            currentSetup = extInfo.sha;
            currentHexInfo = hexinfo;

            hex = hexinfo.hex;

            let i = 0;
            let upperAddr = "0000"
            let lastAddr = 0
            let lastIdx = 0
            bytecodeStartAddr = 0

            let hitEnd = () => {
                if (!bytecodeStartAddr) {
                    let bytes = parseHexBytes(hex[lastIdx])
                    if (bytes[0] != 0x10) {
                        bytes.pop() // checksum
                        bytes[0] = 0x10;
                        while (bytes.length < 20)
                            bytes.push(0x00)
                        hex[lastIdx] = hexBytes(bytes)
                    }
                    assert((bytes[2] & 0xf) == 0)

                    bytecodeStartAddr = lastAddr + 16
                    bytecodeStartIdx = lastIdx + 1
                    bytecodeStartAddrPadded = (bytecodeStartAddr & ~(pageSize - 1)) + pageSize
                    let paddingBytes = bytecodeStartAddrPadded - bytecodeStartAddr
                    assert((paddingBytes & 0xf) == 0)
                    bytecodePaddingSize = paddingBytes
                }
            }

            for (; i < hex.length; ++i) {
                let m = /:02000004(....)/.exec(hex[i])
                if (m) {
                    upperAddr = m[1]
                }
                m = /^:..(....)00/.exec(hex[i])
                if (m) {
                    let newAddr = parseInt(upperAddr + m[1], 16)
                    if (newAddr >= 0x3C000)
                        hitEnd()
                    lastIdx = i
                    lastAddr = newAddr
                }

                if (/^:00000001/.test(hex[i]))
                    hitEnd()

                m = /^:10....000108010842424242010801083ED8E98D/.exec(hex[i])
                if (m) {
                    jmpStartAddr = lastAddr
                    jmpStartIdx = i
                }
            }

            if (!jmpStartAddr)
                oops("No hex start")

            if (!bytecodeStartAddr)
                oops("No hex end")

            funcInfo = {};
            let funs: FuncInfo[] = hexinfo.functions.concat(extInfo.functions);

            for (let i = jmpStartIdx + 1; i < hex.length; ++i) {
                let m = /^:10(....)00(.{16})/.exec(hex[i])

                if (!m) continue;

                let s = hex[i].slice(9)
                while (s.length >= 8) {
                    let inf = funs.shift()
                    if (!inf) return;
                    funcInfo[inf.name] = inf;
                    let hexb = s.slice(0, 8)
                    //console.log(inf.name, hexb)
                    inf.value = parseInt(swapBytes(hexb), 16) & 0xfffffffe
                    if (!inf.value) {
                        U.oops("No value for " + inf.name + " / " + hexb)
                    }
                    s = s.slice(8)
                }
            }

            oops();
        }

        export function validateShim(funname: string, attrs: CommentAttrs, hasRet: boolean, numArgs: number) {
            if (attrs.shim == "TD_ID" || attrs.shim == "TD_NOOP")
                return
            if (U.lookup(asmLabels, attrs.shim))
                return
            let nm = `${funname}(...) (shim=${attrs.shim})`
            let inf = lookupFunc(attrs.shim)
            if (inf) {
                if (!hasRet) {
                    if (inf.type != "P")
                        U.userError("expecting procedure for " + nm);
                } else {
                    if (inf.type != "F")
                        U.userError("expecting function for " + nm);
                }
                if (numArgs != inf.args)
                    U.userError("argument number mismatch: " + numArgs + " vs " + inf.args + " in C++")
            } else {
                U.userError("function not found: " + nm)
            }
        }
        export function lookupFunc(name: string) {
            return funcInfo[name]
        }

        export function lookupFunctionAddr(name: string) {
            let inf = lookupFunc(name)
            if (inf)
                return inf.value
            return null
        }


        export function hexTemplateHash() {
            let sha = currentSetup ? currentSetup.slice(0, 16) : ""
            while (sha.length < 16) sha += "0"
            return sha.toUpperCase()
        }

        export function hexPrelude() {
            return `    .startaddr 0x${bytecodeStartAddrPadded.toString(16)}\n`
        }

        function hexBytes(bytes: number[]) {
            let chk = 0
            let r = ":"
            bytes.forEach(b => chk += b)
            bytes.push((-chk) & 0xff)
            bytes.forEach(b => r += ("0" + b.toString(16)).slice(-2))
            return r.toUpperCase();
        }

        export function patchHex(bin: Binary, buf: number[], shortForm: boolean) {
            let myhex = hex.slice(0, bytecodeStartIdx)

            assert(buf.length < 32000)

            let zeros: number[] = []
            for (let i = 0; i < bytecodePaddingSize >> 1; ++i)
                zeros.push(0)
            buf = zeros.concat(buf)

            let ptr = 0

            function nextLine(buf: number[], addr: number) {
                let bytes = [0x10, (addr >> 8) & 0xff, addr & 0xff, 0]
                for (let j = 0; j < 8; ++j) {
                    bytes.push((buf[ptr] || 0) & 0xff)
                    bytes.push((buf[ptr] || 0) >>> 8)
                    ptr++
                }
                return bytes
            }

            let hd = [0x4209, 0, bytecodeStartAddrPadded & 0xffff, bytecodeStartAddrPadded >>> 16]
            let tmp = hexTemplateHash()
            for (let i = 0; i < 4; ++i)
                hd.push(parseInt(swapBytes(tmp.slice(i * 4, i * 4 + 4)), 16))

            myhex[jmpStartIdx] = hexBytes(nextLine(hd, jmpStartAddr))

            ptr = 0

            if (shortForm) myhex = []

            let addr = bytecodeStartAddr;
            let upper = (addr - 16) >> 16
            while (ptr < buf.length) {
                if ((addr >> 16) != upper) {
                    upper = addr >> 16
                    myhex.push(hexBytes([0x02, 0x00, 0x00, 0x04, upper >> 8, upper & 0xff]))
                }

                myhex.push(hexBytes(nextLine(buf, addr)))
                addr += 16
            }

            if (!shortForm)
                hex.slice(bytecodeStartIdx).forEach(l => myhex.push(l))

            return myhex;
        }


    }

    export function asmline(s: string) {
        if (!/(^[\s;])|(:$)/.test(s))
            s = "    " + s
        return s + "\n"
    }

    function stringLiteral(s: string) {
        let r = "\""
        for (let i = 0; i < s.length; ++i) {
            // TODO generate warning when seeing high character ?
            let c = s.charCodeAt(i) & 0xff
            let cc = String.fromCharCode(c)
            if (cc == "\\" || cc == "\"")
                r += "\\" + cc
            else if (cc == "\n")
                r += "\\n"
            else if (c <= 0xf)
                r += "\\x0" + c.toString(16)
            else if (c < 32 || c > 127)
                r += "\\x" + c.toString(16)
            else
                r += cc;
        }
        return r + "\""
    }

    function emitStrings(bin: Binary) {
        for (let s of Object.keys(bin.strings)) {
            let lbl = bin.strings[s]
            bin.otherLiterals.push(`
.balign 4
${lbl}meta: .short 0xffff, ${s.length}
${lbl}: .string ${stringLiteral(s)}
`)
        }
    }

    function vtableToAsm(info: ClassInfo) {
        let s = `
        .balign ${1 << vtableShift}
${info.id}_VT:
        .short ${info.refmask.length * 4 + 4}  ; size in bytes
        .byte ${info.vtable.length + 2}, 0  ; num. methods
`;

        s += `        .word ${info.id}_IfaceVT\n`
        s += `        .word pxt::RefRecord_destroy|1\n`
        s += `        .word pxt::RefRecord_print|1\n`

        for (let m of info.vtable) {
            s += `        .word ${m.label()}|1\n`
        }

        let refmask = info.refmask.map(v => v ? "1" : "0")
        while (refmask.length < 2 || refmask.length % 2 != 0)
            refmask.push("0")

        s += `        .byte ${refmask.join(",")}\n`

        // VTable for interface method is just linear. If we ever have lots of interface
        // methods and lots of classes this could become a problem. We could use a table
        // of (iface-member-id, function-addr) pairs and binary search.
        // See https://codethemicrobit.com/nymuaedeou for Thumb binary search.
        s += `
        .balign 4
${info.id}_IfaceVT:
`
        for (let m of info.itable) {
            s += `        .word ${m ? m.label() + "|1" : "0"}\n`
        }

        s += "\n"
        return s
    }


    function serialize(bin: Binary) {
        let asmsource = `; start
${hex.hexPrelude()}        
    .hex 708E3B92C615A841C49866C975EE5197 ; magic number
    .hex ${hex.hexTemplateHash()} ; hex template hash
    .hex 0000000000000000 ; @SRCHASH@
    .short ${bin.globalsWords}   ; num. globals
    .space 14 ; reserved
`
        bin.procs.forEach(p => {
            asmsource += "\n" + irToAssembly(bin, p) + "\n"
        })

        bin.usedClassInfos.forEach(info => {
            asmsource += vtableToAsm(info)
        })

        U.iterMap(bin.codeHelpers, (code, lbl) => {
            asmsource += `    .section code\n${lbl}:\n${code}\n`
        })

        asmsource += hex.asmTotalSource

        asmsource += "_js_end:\n"
        emitStrings(bin)
        asmsource += bin.otherLiterals.join("")
        asmsource += "_program_end:\n"

        return asmsource
    }

    function patchSrcHash(src: string) {
        let sha = U.sha256(src)
        return src.replace(/\n.*@SRCHASH@\n/, "\n    .hex " + sha.slice(0, 16).toUpperCase() + " ; program hash\n")
    }

    export function thumbInlineAssemble(src: string) {
        let b = mkThumbFile()
        b.disablePeepHole = true
        b.emit(src)
        throwThumbErrors(b)

        let res: number[] = []
        for (let i = 0; i < b.buf.length; i += 2) {
            res.push((((b.buf[i + 1] || 0) << 16) | b.buf[i]) >>> 0)
        }
        return res
    }

    function mkThumbFile() {
        let tp = new thumb.ThumbProcessor()
        thumb.testThumb(tp); // just in case

        let b = new assembler.File(tp);
        b.lookupExternalLabel = hex.lookupFunctionAddr;
        b.normalizeExternalLabel = s => {
            let inf = hex.lookupFunc(s)
            if (inf) return inf.name;
            return s
        }
        // b.throwOnError = true;

        return b
    }

    function throwThumbErrors(b: assembler.File) {
        if (b.errors.length > 0) {
            let userErrors = ""
            b.errors.forEach(e => {
                let m = /^user(\d+)/.exec(e.scope)
                if (m) {
                    // This generally shouldn't happen, but it may for certin kind of global 
                    // errors - jump range and label redefinitions
                    let no = parseInt(m[1]) // TODO lookup assembly file name
                    userErrors += U.lf("At inline assembly:\n")
                    userErrors += e.message
                }
            })

            if (userErrors) {
                //TODO
                console.log(U.lf("errors in inline assembly"))
                console.log(userErrors)
                throw new Error(b.errors[0].message)
            } else {
                throw new Error(b.errors[0].message)
            }
        }
    }

    let peepDbg = false
    function assemble(bin: Binary, src: string) {
        let b = mkThumbFile()
        b.emit(src);

        src = b.getSource(!peepDbg);

        throwThumbErrors(b)

        return {
            src: src,
            buf: b.buf,
            thumbFile: b
        }
    }

    function addSource(meta: string, binstring: string) {
        let metablob = Util.toUTF8(meta)
        let totallen = metablob.length + binstring.length

        if (totallen > 40000) {
            return "; program too long\n";
        }

        let str =
            `
    .balign 16
    .hex 41140E2FB82FA2BB
    .short ${metablob.length}
    .short ${binstring.length}
    .short 0, 0   ; future use

_stored_program: .string "`

        let addblob = (b: string) => {
            for (let i = 0; i < b.length; ++i) {
                let v = b.charCodeAt(i) & 0xff
                if (v <= 0xf)
                    str += "\\x0" + v.toString(16)
                else
                    str += "\\x" + v.toString(16)
            }
        }

        addblob(metablob)
        addblob(binstring)

        str += "\"\n"
        return str
    }

    export function thumbEmit(bin: Binary, opts: CompileOptions, cres: CompileResult) {
        let src = serialize(bin)
        src = patchSrcHash(src)
        if (opts.embedBlob)
            src += addSource(opts.embedMeta, decodeBase64(opts.embedBlob))
        bin.writeFile(pxtc.BINARY_ASM, src)
        let res = assemble(bin, src)
        if (res.src)
            bin.writeFile(pxtc.BINARY_ASM, res.src)
        if (res.buf) {
            const myhex = hex.patchHex(bin, res.buf, false).join("\r\n") + "\r\n"
            bin.writeFile(pxtc.BINARY_HEX, myhex)
            cres.quickFlash = {
                startAddr: hex.bytecodeStartAddrPadded,
                words: []
            }
            for (let i = 0; i < res.buf.length; i += 2) {
                cres.quickFlash.words.push(res.buf[i] | (res.buf[i + 1] << 16))
            }
            while (cres.quickFlash.words.length & ((hex.pageSize >> 2) - 1))
                cres.quickFlash.words.push(0)
        }

        for (let bkpt of cres.breakpoints) {
            let lbl = U.lookup(res.thumbFile.getLabels(), "__brkp_" + bkpt.id)
            if (lbl != null)
                bkpt.binAddr = lbl
        }

        for (let proc of bin.procs) {
            proc.fillDebugInfo(res.thumbFile)
        }

        cres.procDebugInfo = bin.procs.map(p => p.debugInfo)
    }

    export let validateShim = hex.validateShim;
}
