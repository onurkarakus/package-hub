import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { isMsBuildProject, isPackageDocumentPath } from "../services/projectFiles";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRef } from "../utils/nugetAudit";
import {
    packageLineFacts,
    packageLineHasProblem,
    packageLineMark,
    PackageLineFacts,
    PackageLineMark,
} from "./packageLineMark";

const MARK_COLOR: Record<PackageLineMark["kind"], string> = {
    vulnerable: "editorWarning.foreground",
    outdated: "editorError.foreground",
    deprecated: "charts.orange",
    current: "testing.iconPassed",
};

export class PackageLineDecorations implements vscode.Disposable {
    private readonly vulnerableMark = vscode.window.createTextEditorDecorationType({});
    private readonly outdatedMark = vscode.window.createTextEditorDecorationType({});
    private readonly deprecatedMark = vscode.window.createTextEditorDecorationType({});
    private readonly currentMark = vscode.window.createTextEditorDecorationType({});
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(private readonly scanner: WorkspaceScanner) {
        this.subscriptions.push(
            this.vulnerableMark,
            this.outdatedMark,
            this.deprecatedMark,
            this.currentMark,
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
        const current: vscode.DecorationOptions[] = [];

        if (ScanState.getScannedAt() && isPackageDocument(editor.document)) {
            const projectName = isMsBuildProject(editor.document.uri.fsPath)
                ? this.scanner.getProjectName(editor.document.uri)
                : undefined;

            for (let line = 0; line < editor.document.lineCount; line++) {
                const ref = readPackageRef(editor.document.lineAt(line).text);
                if (!ref) {
                    continue;
                }

                const found = ScanState.findPackage(ref.id);
                const rawVulnerable = ScanState.getAllVulnerable().find(
                    (pkg) => pkg.id.toLowerCase() === ref.id.toLowerCase()
                );
                const problems = {
                    vulnerable: packageLineFacts(rawVulnerable, projectName),
                    outdated: packageLineFacts(found.outdated, projectName),
                    deprecated: packageLineFacts(found.deprecated, projectName),
                };
                const blocked = packageLineHasProblem(ref.version, problems);
                const mark = packageLineMark(ref.version, {
                    vulnerable: packageLineFacts(found.vulnerable, projectName),
                    outdated: problems.outdated,
                    deprecated: problems.deprecated,
                    current: blocked ? undefined : installedFacts(ref.id, projectName),
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
                } else if (mark.kind === "deprecated") {
                    deprecated.push(option);
                } else {
                    current.push(option);
                }
            }
        }

        editor.setDecorations(this.vulnerableMark, vulnerable);
        editor.setDecorations(this.outdatedMark, outdated);
        editor.setDecorations(this.deprecatedMark, deprecated);
        editor.setDecorations(this.currentMark, current);
    }
}

function installedFacts(
    packageId: string,
    projectName: string | undefined
): PackageLineFacts | undefined {
    const installed = ScanState.findInstalled(packageId);
    if (!installed || !inventoryProves(installed, projectName)) {
        return undefined;
    }

    return packageLineFacts(installed, projectName);
}

function inventoryProves(installed: PackageInfo, projectName: string | undefined): boolean {
    const owners = installed.projects || [];
    if (projectName) {
        return ScanState.isProjectProven(projectName);
    }

    return owners.length > 0 && owners.every((name) => ScanState.isProjectProven(name));
}

function isPackageDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === "file" && isPackageDocumentPath(document.uri.fsPath);
}
