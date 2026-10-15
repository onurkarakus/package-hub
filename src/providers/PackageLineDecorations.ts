import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRef } from "../utils/nugetAudit";
import { packageLineFacts, packageLineMark, PackageLineMark } from "./packageLineMark";

const MARK_COLOR: Record<PackageLineMark["kind"], string> = {
    vulnerable: "editorWarning.foreground",
    outdated: "editorError.foreground",
    deprecated: "charts.orange",
};

export class PackageLineDecorations implements vscode.Disposable {
    private readonly vulnerableMark = vscode.window.createTextEditorDecorationType({});
    private readonly outdatedMark = vscode.window.createTextEditorDecorationType({});
    private readonly deprecatedMark = vscode.window.createTextEditorDecorationType({});
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(private readonly scanner: WorkspaceScanner) {
        this.subscriptions.push(
            this.vulnerableMark,
            this.outdatedMark,
            this.deprecatedMark,
            vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (!isPackageDocument(event.document)) {
                    return;
                }

                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === event.document) {
                        this.paint(editor);
                    }
                }
            })
        );
        this.refresh();
    }

    refresh(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.paint(editor);
        }
    }

    dispose(): void {
        for (const item of this.subscriptions) {
            item.dispose();
        }
    }

    private paint(editor: vscode.TextEditor): void {
        const vulnerable: vscode.DecorationOptions[] = [];
        const outdated: vscode.DecorationOptions[] = [];
        const deprecated: vscode.DecorationOptions[] = [];

        if (ScanState.getScannedAt() && isPackageDocument(editor.document)) {
            const projectName = editor.document.uri.fsPath.toLowerCase().endsWith(".csproj")
                ? this.scanner.getProjectName(editor.document.uri)
                : undefined;

            for (let line = 0; line < editor.document.lineCount; line++) {
                const ref = readPackageRef(editor.document.lineAt(line).text);
                if (!ref) {
                    continue;
                }

                const found = ScanState.findPackage(ref.id);
                const mark = packageLineMark(ref.version, {
                    vulnerable: packageLineFacts(found.vulnerable, projectName),
                    outdated: packageLineFacts(found.outdated, projectName),
                    deprecated: packageLineFacts(found.deprecated, projectName),
                });
                if (!mark) {
                    continue;
                }

                const end = editor.document.lineAt(line).range.end;
                const option: vscode.DecorationOptions = {
                    range: new vscode.Range(end, end),
                    hoverMessage: mark.hover,
                    renderOptions: {
                        after: {
                            contentText: mark.text,
                            margin: "0 0 0 1em",
                            color: new vscode.ThemeColor(MARK_COLOR[mark.kind]),
                        },
                    },
                };

                if (mark.kind === "vulnerable") {
                    vulnerable.push(option);
                } else if (mark.kind === "outdated") {
                    outdated.push(option);
                } else {
                    deprecated.push(option);
                }
            }
        }

        editor.setDecorations(this.vulnerableMark, vulnerable);
        editor.setDecorations(this.outdatedMark, outdated);
        editor.setDecorations(this.deprecatedMark, deprecated);
    }
}

function isPackageDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== "file") {
        return false;
    }

    const path = document.uri.fsPath.toLowerCase();
    return path.endsWith(".csproj") || path.endsWith(".props");
}
