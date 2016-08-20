/// <reference path="../../built/pxtlib.d.ts"/>

/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/
'use strict';

import {LanguageServiceDefaultsImpl} from './monaco.contribution';
import * as typescript from '../lib/typescriptServices';
import {TypeScriptWorker} from './worker';

import Uri = monaco.Uri;
import Position = monaco.Position;
import Range = monaco.Range;
import Thenable = monaco.Thenable;
import Promise = monaco.Promise;
import CancellationToken = monaco.CancellationToken;
import IDisposable = monaco.IDisposable;


let snippets = {
	"For Loop": {
		"prefix": "for",
		"body": [
			"for (let ${index} = 0; ${index} < {{4}}; ${index}++) {",
			"\t$0",
			"}"
		],
		"description": "For Loop"
	},
	"If Statement": {
		"prefix": "if",
		"body": [
			"if (${condition}) {",
			"\t$0",
			"}"
		],
		"description": "If Statement"
	},
	"If-Else Statement": {
		"prefix": "ifelse",
		"body": [
			"if (${condition}) {",
			"\t$0",
			"} else {",
			"\t",
			"}"
		],
		"description": "If-Else Statement"
	},
	"While Statement": {
		"prefix": "while",
		"body": [
			"while (${condition}) {",
			"\t$0",
			"}"
		],
		"description": "While Statement"
	}
}

export abstract class Adapter {

    constructor(protected _worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>) {
    }

    protected _positionToOffset(uri: Uri, position: monaco.IPosition): number {
        let model = monaco.editor.getModel(uri);
        return model.getOffsetAt(position);
    }

    protected _offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
        let model = monaco.editor.getModel(uri);
        return model.getPositionAt(offset);
    }

    protected _textSpanToRange(uri: Uri, span: typescript.TextSpan): monaco.IRange {
        let p1 = this._offsetToPosition(uri, span.start);
        let p2 = this._offsetToPosition(uri, span.start + span.length);
        let {lineNumber: startLineNumber, column: startColumn} = p1;
        let {lineNumber: endLineNumber, column: endColumn} = p2;
        return { startLineNumber, startColumn, endLineNumber, endColumn };
    }
}

// --- diagnostics --- ---

export class DiagnostcsAdapter extends Adapter {

    private _disposables: IDisposable[] = [];
    private _listener: { [uri: string]: IDisposable } = Object.create(null);

    constructor(private _defaults: LanguageServiceDefaultsImpl, private _selector: string,
        worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>
    ) {
        super(worker);

        const onModelAdd = (model: monaco.editor.IModel): void => {
            if (model.getModeId() !== _selector) {
                return;
            }

            let handle: number;
            this._listener[model.uri.toString()] = model.onDidChangeContent(() => {
                clearTimeout(handle);
                handle = setTimeout(() => this._doValidate(model.uri), 500);
            });

            this._doValidate(model.uri);
        };

        const onModelRemoved = (model: monaco.editor.IModel): void => {
            delete this._listener[model.uri.toString()];
        };

        this._disposables.push(monaco.editor.onDidCreateModel(onModelAdd));
        this._disposables.push(monaco.editor.onWillDisposeModel(onModelRemoved));
        this._disposables.push(monaco.editor.onDidChangeModelLanguage(event => {
            onModelRemoved(event.model);
            onModelAdd(event.model);
        }));

        this._disposables.push({
            dispose: () => {
                for (let key in this._listener) {
                    this._listener[key].dispose();
                }
            }
        });

        monaco.editor.getModels().forEach(onModelAdd);
    }

    public dispose(): void {
        this._disposables.forEach(d => d && d.dispose());
        this._disposables = [];
    }

    private _doValidate(resource: Uri): void {
        this._worker(resource).then(worker => {
            let promises: Promise<typescript.Diagnostic[]>[] = [];
            if (!this._defaults.diagnosticsOptions.noSyntaxValidation) {
                promises.push(worker.getSyntacticDiagnostics(resource.toString()));
            }
            if (!this._defaults.diagnosticsOptions.noSemanticValidation) {
                promises.push(worker.getSemanticDiagnostics(resource.toString()));
            }
            return Promise.join(promises);
        }).then(diagnostics => {
            const markers = diagnostics
                .reduce((p, c) => c.concat(p), [])
                .map(d => this._convertDiagnostics(resource, d));

            monaco.editor.setModelMarkers(monaco.editor.getModel(resource), this._selector, markers);
        }).done(undefined, err => {
            console.error(err);
        });
    }

    private _convertDiagnostics(resource: Uri, diag: typescript.Diagnostic): monaco.editor.IMarkerData {
        const {lineNumber: startLineNumber, column: startColumn} = this._offsetToPosition(resource, diag.start);
        const {lineNumber: endLineNumber, column: endColumn} = this._offsetToPosition(resource, diag.start + diag.length);

        return {
            severity: monaco.Severity.Error,
            startLineNumber,
            startColumn,
            endLineNumber,
            endColumn,
            message: typescript.flattenDiagnosticMessageText(diag.messageText, '\n')
        };
    }
}

// --- suggest ------

interface MyCompletionItem extends monaco.languages.CompletionItem {
    model: monaco.editor.IReadOnlyModel;
    uri: Uri;
    position: Position;
}

interface TypescriptSnippet {
    prefix: string;
    body: string;
    description?: string;
}

export class SuggestAdapter extends Adapter implements monaco.languages.CompletionItemProvider {

    private typescriptSnippets: TypescriptSnippet[] = [];

    constructor(worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>) {
        super(worker);

        Object.keys(snippets).forEach((snippetKey) => {
            let snippet = (snippets as any)[snippetKey];
            let prefix = (snippet as any).prefix;
            let body: string = "";
            (snippet as any).body.forEach((element: string) => {
                body += element.replace("$0","{{}}").replace(/\${(.*?)}/gi, "{{$1}}") + "\n";
            });;
            let description = (snippet as any).description;
            this.typescriptSnippets.push({
                prefix: prefix,
                body: body,
                description: description
            })
        });
    }

    public get triggerCharacters(): string[] {
        return ['.'];
    }

    provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.CompletionItem[]> {
        const wordInfo = model.getWordUntilPosition(position);
        const resource = model.uri;
        const offset = this._positionToOffset(resource, position);

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getCompletionsAtPosition(resource.toString(), offset);
        }).then(info => {
            if (!info) {
                return;
            }
            let suggestions: MyCompletionItem[] = info.entries.map(entry => {
                return {
                    model: model,
                    uri: resource,
                    position: position,
                    label: entry.name,
                    sortText: entry.sortText,
                    kind: SuggestAdapter.convertKind(entry.kind)
                };
            });
            // Add Typescript snippets
            this.typescriptSnippets
                .filter(entry => entry.prefix.indexOf(wordInfo.word,0) > -1)
                .forEach(entry => {
                let completionItem: MyCompletionItem = 
                {
                    model: model,
                    uri: resource,
                    position: position,
                    label: entry.prefix,
                    sortText: "-1",
                    kind: monaco.languages.CompletionItemKind.Snippet
                };
                suggestions.push(completionItem);
            });
            return suggestions;
        }));
    }

    resolveCompletionItem(item: monaco.languages.CompletionItem, token: CancellationToken): Thenable<monaco.languages.CompletionItem> {
        let myItem = <MyCompletionItem>item;
        const resource = myItem.uri;
        const position = myItem.position;
        const model = myItem.model;

        let entry: TypescriptSnippet = this.typescriptSnippets.filter(snippet => snippet.prefix == myItem.label)[0];
        if (entry) {
            return new Promise<monaco.languages.CompletionItem>((resolve, reject) => {
                myItem.insertText = entry.body;
                myItem.documentation = entry.description;
                resolve(myItem);
            })
        }

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getCompletionEntryDetails(resource.toString(),
                this._positionToOffset(resource, position),
                myItem.label);
        }).then(details => {
            if (!details) {
                return myItem;
            }
            myItem.model = model;
            myItem.uri = resource;
            myItem.position = position;
            myItem.label = details.name;
            myItem.kind = SuggestAdapter.convertKind(details.kind);
            myItem.detail = typescript.displayPartsToString(details.displayParts);
            myItem.documentation = typescript.displayPartsToString(details.documentation);

            const defaultImgLit = `
    . . . . .
    . . . . .
    . . # . .
    . . . . .
    . . . . .
    `
            let renderDefaultVal = function (name: string, type: string): string {
                switch (type) {
                    case "number": return "{{0}}";
                    case "boolean": return "{{false}}";
                    case "string": return (name == "leds" ? "`" + defaultImgLit + "`" : "\"{{}}\"");
                }
                let m = /^\((.*)\) => (.*)$/.exec(type)
                if (m)
                    return `(${m[1]}) => {\n    {{}}\n}`
                return `{{${name}}}`;
            }
            let hasParams = myItem.kind == monaco.languages.CompletionItemKind.Function || myItem.kind == monaco.languages.CompletionItemKind.Method;

            if (hasParams) {
                let codeSnippet = details.name;
                let suggestionArgumentNames: string[] = [];
                let decl = ts.displayPartsToString(details.displayParts);
                let parameterString = /function .+\..+?\((.*)\):.*/i.exec(decl)[1];
                if (parameterString) {
                    let reg: RegExp = /((.*?)([\?]+)?: ([^,]*)[, ]*)/gi;
                    let match: RegExpExecArray;
                    while ((match = reg.exec(parameterString)) !== null) {
                        if (match[3] == '?') {
                            // optional parameter, do nothing
                        } else {
                            suggestionArgumentNames.push(renderDefaultVal(match[2],match[4]))
                        }
                    }
                }
                if (suggestionArgumentNames.length > 0) {
                    codeSnippet += '(' + suggestionArgumentNames.join(', ') + ')';
                } else {
                    codeSnippet += '()';
                }
                myItem.insertText = codeSnippet;
            }
            return myItem;
        }));
    }

    private static convertKind(kind: string): monaco.languages.CompletionItemKind {
        switch (kind) {
            case Kind.primitiveType:
            case Kind.keyword:
                return monaco.languages.CompletionItemKind.Keyword;
            case Kind.variable:
            case Kind.localVariable:
                return monaco.languages.CompletionItemKind.Variable;
            case Kind.memberVariable:
            case Kind.memberGetAccessor:
            case Kind.memberSetAccessor:
                return monaco.languages.CompletionItemKind.Field;
            case Kind.function:
            case Kind.memberFunction:
            case Kind.constructSignature:
            case Kind.callSignature:
            case Kind.indexSignature:
                return monaco.languages.CompletionItemKind.Function;
            case Kind.enum:
                return monaco.languages.CompletionItemKind.Enum;
            case Kind.module:
                return monaco.languages.CompletionItemKind.Module;
            case Kind.class:
                return monaco.languages.CompletionItemKind.Class;
            case Kind.interface:
                return monaco.languages.CompletionItemKind.Interface;
            case Kind.warning:
                return monaco.languages.CompletionItemKind.File;
        }

        return monaco.languages.CompletionItemKind.Property;
    }
}

export class SignatureHelpAdapter extends Adapter implements monaco.languages.SignatureHelpProvider {

    public signatureHelpTriggerCharacters = ['(', ','];

    provideSignatureHelp(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.SignatureHelp> {
        let resource = model.uri;
        return wireCancellationToken(token, this._worker(resource).then(worker => worker.getSignatureHelpItems(resource.toString(), this._positionToOffset(resource, position))).then(info => {

            if (!info) {
                return;
            }

            let ret: monaco.languages.SignatureHelp = {
                activeSignature: info.selectedItemIndex,
                activeParameter: info.argumentIndex,
                signatures: []
            };

            info.items.forEach(item => {

                let signature: monaco.languages.SignatureInformation = {
                    label: '',
                    documentation: null,
                    parameters: []
                };

                signature.label += typescript.displayPartsToString(item.prefixDisplayParts);
                item.parameters.forEach((p, i, a) => {
                    let label = typescript.displayPartsToString(p.displayParts);
                    let parameter: monaco.languages.ParameterInformation = {
                        label: label,
                        documentation: typescript.displayPartsToString(p.documentation)
                    };
                    signature.label += label;
                    signature.parameters.push(parameter);
                    if (i < a.length - 1) {
                        signature.label += typescript.displayPartsToString(item.separatorDisplayParts);
                    }
                });
                signature.label += typescript.displayPartsToString(item.suffixDisplayParts);
                ret.signatures.push(signature);
            });

            return ret;

        }));
    }
}

// --- hover ------

export class QuickInfoAdapter extends Adapter implements monaco.languages.HoverProvider {

    provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
        let resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getQuickInfoAtPosition(resource.toString(), this._positionToOffset(resource, position));
        }).then(info => {
            if (!info) {
                return;
            }
            let contents = typescript.displayPartsToString(info.displayParts);
            return {
                range: this._textSpanToRange(resource, info.textSpan),
                contents: [contents]
            };
        }));
    }
}

// --- occurrences ------

export class OccurrencesAdapter extends Adapter implements monaco.languages.DocumentHighlightProvider {

    public provideDocumentHighlights(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.DocumentHighlight[]> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getOccurrencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
        }).then(entries => {
            if (!entries) {
                return;
            }
            return entries.map(entry => {
                return <monaco.languages.DocumentHighlight>{
                    range: this._textSpanToRange(resource, entry.textSpan),
                    kind: entry.isWriteAccess ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text
                };
            });
        }));
    }
}

// --- definition ------

export class DefinitionAdapter extends Adapter {

    public provideDefinition(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Definition> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getDefinitionAtPosition(resource.toString(), this._positionToOffset(resource, position));
        }).then(entries => {
            if (!entries) {
                return;
            }
            const result: monaco.languages.Location[] = [];
            for (let entry of entries) {
                const uri = Uri.parse(entry.fileName);
                if (monaco.editor.getModel(uri)) {
                    result.push({
                        uri: uri,
                        range: this._textSpanToRange(uri, entry.textSpan)
                    });
                }
            }
            return result;
        }));
    }
}

// --- references ------

export class ReferenceAdapter extends Adapter implements monaco.languages.ReferenceProvider {

    provideReferences(model: monaco.editor.IReadOnlyModel, position: Position, context: monaco.languages.ReferenceContext, token: CancellationToken): Thenable<monaco.languages.Location[]> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getReferencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
        }).then(entries => {
            if (!entries) {
                return;
            }
            const result: monaco.languages.Location[] = [];
            for (let entry of entries) {
                const uri = Uri.parse(entry.fileName);
                if (monaco.editor.getModel(uri)) {
                    result.push({
                        uri: uri,
                        range: this._textSpanToRange(uri, entry.textSpan)
                    });
                }
            }
            return result;
        }));
    }
}

// --- outline ------

export class OutlineAdapter extends Adapter implements monaco.languages.DocumentSymbolProvider {

    public provideDocumentSymbols(model: monaco.editor.IReadOnlyModel, token: CancellationToken): Thenable<monaco.languages.SymbolInformation[]> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => worker.getNavigationBarItems(resource.toString())).then(items => {
            if (!items) {
                return;
            }

            function convert(bucket: monaco.languages.SymbolInformation[], item: typescript.NavigationBarItem, containerLabel?: string): void {
                let result: monaco.languages.SymbolInformation = {
                    name: item.text,
                    kind: outlineTypeTable[item.kind] || monaco.languages.SymbolKind.Variable,
                    location: {
                        uri: resource,
                        range: this._textSpanToRange(resource, item.spans[0])
                    },
                    containerName: containerLabel
                };

                if (item.childItems && item.childItems.length > 0) {
                    for (let child of item.childItems) {
                        convert(bucket, child, result.name);
                    }
                }

                bucket.push(result);
            }

            let result: monaco.languages.SymbolInformation[] = [];
            items.forEach(item => convert(result, item));
            return result;
        }));
    }
}

export class Kind {
    public static unknown: string = '';
    public static keyword: string = 'keyword';
    public static script: string = 'script';
    public static module: string = 'module';
    public static class: string = 'class';
    public static interface: string = 'interface';
    public static type: string = 'type';
    public static enum: string = 'enum';
    public static variable: string = 'var';
    public static localVariable: string = 'local var';
    public static function: string = 'function';
    public static localFunction: string = 'local function';
    public static memberFunction: string = 'method';
    public static memberGetAccessor: string = 'getter';
    public static memberSetAccessor: string = 'setter';
    public static memberVariable: string = 'property';
    public static constructorImplementation: string = 'constructor';
    public static callSignature: string = 'call';
    public static indexSignature: string = 'index';
    public static constructSignature: string = 'construct';
    public static parameter: string = 'parameter';
    public static typeParameter: string = 'type parameter';
    public static primitiveType: string = 'primitive type';
    public static label: string = 'label';
    public static alias: string = 'alias';
    public static const: string = 'const';
    public static let: string = 'let';
    public static warning: string = 'warning';
}

let outlineTypeTable: { [kind: string]: monaco.languages.SymbolKind } = Object.create(null);
outlineTypeTable[Kind.module] = monaco.languages.SymbolKind.Module;
outlineTypeTable[Kind.class] = monaco.languages.SymbolKind.Class;
outlineTypeTable[Kind.enum] = monaco.languages.SymbolKind.Enum;
outlineTypeTable[Kind.interface] = monaco.languages.SymbolKind.Interface;
outlineTypeTable[Kind.memberFunction] = monaco.languages.SymbolKind.Method;
outlineTypeTable[Kind.memberVariable] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberGetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberSetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.const] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.localVariable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.function] = monaco.languages.SymbolKind.Function;
outlineTypeTable[Kind.localFunction] = monaco.languages.SymbolKind.Function;

// --- formatting ----

export abstract class FormatHelper extends Adapter {
    protected static _convertOptions(options: monaco.languages.FormattingOptions): typescript.FormatCodeOptions {
        return {
            ConvertTabsToSpaces: options.insertSpaces,
            TabSize: options.tabSize,
            IndentSize: options.tabSize,
            IndentStyle: typescript.IndentStyle.Smart,
            NewLineCharacter: '\n',
            InsertSpaceAfterCommaDelimiter: true,
            InsertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
            InsertSpaceAfterKeywordsInControlFlowStatements: false,
            InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: true,
            InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: true,
            InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: true,
            InsertSpaceAfterSemicolonInForStatements: false,
            InsertSpaceBeforeAndAfterBinaryOperators: true,
            PlaceOpenBraceOnNewLineForControlBlocks: false,
            PlaceOpenBraceOnNewLineForFunctions: false
        };
    }

    protected _convertTextChanges(uri: Uri, change: typescript.TextChange): monaco.editor.ISingleEditOperation {
        return <monaco.editor.ISingleEditOperation>{
            text: change.newText,
            range: this._textSpanToRange(uri, change.span)
        };
    }
}

export class FormatAdapter extends FormatHelper implements monaco.languages.DocumentRangeFormattingEditProvider {

    provideDocumentRangeFormattingEdits(model: monaco.editor.IReadOnlyModel, range: Range, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getFormattingEditsForRange(resource.toString(),
                this._positionToOffset(resource, { lineNumber: range.startLineNumber, column: range.startColumn }),
                this._positionToOffset(resource, { lineNumber: range.endLineNumber, column: range.endColumn }),
                FormatHelper._convertOptions(options));
        }).then(edits => {
            if (edits) {
                return edits.map(edit => this._convertTextChanges(resource, edit));
            }
            return null;
        }));
    }
}

export class FormatOnTypeAdapter extends FormatHelper implements monaco.languages.OnTypeFormattingEditProvider {

    get autoFormatTriggerCharacters() {
        return [';', '}', '\n'];
    }

    provideOnTypeFormattingEdits(model: monaco.editor.IReadOnlyModel, position: Position, ch: string, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
        const resource = model.uri;

        return wireCancellationToken(token, this._worker(resource).then(worker => {
            return worker.getFormattingEditsAfterKeystroke(resource.toString(),
                this._positionToOffset(resource, position),
                ch, FormatHelper._convertOptions(options));
        }).then(edits => {
            if (edits) {
                return edits.map(edit => this._convertTextChanges(resource, edit));
            }
            return null;
        }));
    }
}

/**
 * Hook a cancellation token to a WinJS Promise
 */
function wireCancellationToken<T>(token: CancellationToken, promise: Promise<T>): Thenable<T> {
    token.onCancellationRequested(() => promise.cancel());
    return promise;
}
