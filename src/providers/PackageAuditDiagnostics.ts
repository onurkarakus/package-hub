import * as fs from "fs/promises";
import * as vscode from "vscode";
import { PackageInfo, TransitiveOrigin } from "../models/PackageInfo";
import { isMsBuildProject, isPackageDocumentPath } from "../services/projectFiles";
import { originForProject } from "../services/TransitiveOrigin";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { logger } from "../utils/logger";
import { auditCodeForSeverity, readPackageRefs } from "../utils/nugetAudit";

export class PackageAuditDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("packageHub");
    private affectedProjectPaths: string[] = [];
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly editTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly scanner: WorkspaceScanner) {
        this.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.scheme !== "file" || !isPackageDocumentPath(event.document.uri.fsPath)) {
                    return;
                }
                this.scheduleDocument(event.document);
            })
        );
    }

    /**
     * Recomputes diagnostics for one open document from its buffer, 300 ms
     * after the last edit.
     */
    private scheduleDocument(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const pending = this.editTimers.get(key);
        if (pending) {
            clearTimeout(pending);
        }
        this.editTimers.set(key, setTimeout(() => {
            this.editTimers.delete(key);
            void this.refreshDocument(document);
        }, 300));
    }

    async refreshDocument(document: vscode.TextDocument): Promise<void> {
        if (!ScanState.getScannedAt() || document.isClosed) {
            return;
        }
        const diagnostics = this.diagnosticsForText(document.uri, document.getText(), ScanState.getVulnerable());
        this.collection.set(document.uri, diagnostics);
    }

    affectedProjects(): string[] {
        return this.affectedProjectPaths;
    }

    async refresh(): Promise<void> {
        this.collection.clear();
        this.affectedProjectPaths = [];

        if (!ScanState.getScannedAt()) {
            return;
        }

        const vulnerable = ScanState.getVulnerable();
        const projects = await this.scanner.findProjects();
        const propsFiles = await this.scanner.findCentralPackageManagementFiles();
        const affected = new Set<string>();

        for (const uri of [...projects, ...propsFiles]) {
            const diagnostics = await this.diagnosticsForFile(uri, vulnerable);
            if (diagnostics.length > 0) {
                this.collection.set(uri, diagnostics);
            }

            if (isMsBuildProject(uri.fsPath) && diagnostics.length > 0) {
                affected.add(uri.fsPath);
            }
        }

        for (const uri of projects) {
            const name = this.scanner.getProjectName(uri);
            const ownsVulnerable = vulnerable.some((pkg) => this.packageInProject(pkg, name));
            if (ownsVulnerable) {
                affected.add(uri.fsPath);
            }
        }

        this.affectedProjectPaths = [...affected];

    }

    dispose(): void {
        for (const timer of this.editTimers.values()) {
            clearTimeout(timer);
        }
        this.editTimers.clear();
        for (const item of this.subscriptions) {
            item.dispose();
        }
        this.collection.dispose();
    }

    private packageInProject(pkg: PackageInfo, projectName: string): boolean {
        return pkg.projects.some((name) => name.toLowerCase() === projectName.toLowerCase());
    }

    private transitiveInProject(pkg: PackageInfo, projectName: string): boolean {
        const named = pkg.transitiveProjects || [];
        if (named.some((name) => name.toLowerCase() === projectName.toLowerCase())) {
            return true;
        }

        return pkg.isTransitive && this.packageInProject(pkg, projectName);
    }

    private lineForBroughtBy(lines: string[], broughtBy: string | undefined): number {
        if (!broughtBy) {
            return 0;
        }

        const needle = broughtBy.toLowerCase();
        const index = lines.findIndex((line) => {
            const include = line.match(/(?:Include|Update)\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
            if (!include) {
                return false;
            }

            const value = (include[1] ?? include[2]).toLowerCase();
            return value === needle
                || value.endsWith(`/${needle}.csproj`)
                || value.endsWith(`\\${needle}.csproj`)
                || value.endsWith(`${needle}.csproj`)
                || value.endsWith(`/${needle}.fsproj`)
                || value.endsWith(`\\${needle}.fsproj`)
                || value.endsWith(`${needle}.fsproj`);
        });

        return index >= 0 ? index : 0;
    }

    /**
     * Reads an open document from the editor buffer, so unsaved edits count.
     * A closed file is read from disk.
     */
    private async diagnosticsForFile(
        uri: vscode.Uri,
        vulnerable: PackageInfo[]
    ): Promise<vscode.Diagnostic[]> {
        const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
        let text = "";
        if (open) {
            text = open.getText();
        } else {
            try {
                text = await fs.readFile(uri.fsPath, "utf8");
            } catch (error: any) {
                logger.error(`Could not read the file for diagnostics (${uri.fsPath}): ${error.message}`);
                return [];
            }
        }
        return this.diagnosticsForText(uri, text, vulnerable);
    }

    private diagnosticsForText(
        uri: vscode.Uri,
        text: string,
        vulnerable: PackageInfo[]
    ): vscode.Diagnostic[] {
        const lines = text.split(/\r?\n/);
        const diagnostics: vscode.Diagnostic[] = [];
        const seen = new Set<string>();
        const isProject = isMsBuildProject(uri.fsPath);
        const projectName = isProject ? this.scanner.getProjectName(uri) : undefined;

        for (const ref of readPackageRefs(text)) {
            const index = ref.line;
            const line = lines[index] ?? "";
            const pkg = vulnerable.find((item) => item.id.toLowerCase() === ref.id.toLowerCase());
            if (!pkg) {
                continue;
            }

            if (projectName && !this.packageInProject(pkg, projectName)) {
                continue;
            }

            if (this.lineAlreadyReported(uri, index, pkg.id)) {
                continue;
            }

            diagnostics.push(this.createDiagnostic(index, line, pkg, false, undefined, projectName));
            seen.add(pkg.id.toLowerCase());
        }

        if (projectName) {
            for (const pkg of vulnerable) {
                if (!this.transitiveInProject(pkg, projectName) || seen.has(pkg.id.toLowerCase())) {
                    continue;
                }

                if (!this.packageInProject(pkg, projectName)) {
                    continue;
                }

                const origin = originForProject(pkg, projectName);
                const line = this.lineForBroughtBy(lines, origin?.broughtBy);
                if (this.lineAlreadyReported(uri, line, pkg.id)) {
                    continue;
                }

                diagnostics.push(this.createDiagnostic(line, lines[line] || "", pkg, true, origin, projectName));
            }
        }

        return diagnostics;
    }

    private lineAlreadyReported(uri: vscode.Uri, line: number, packageId: string): boolean {
        return vscode.languages.getDiagnostics(uri).some((diagnostic) => {
            if (diagnostic.source === "PackageHub") {
                return false;
            }

            if (diagnostic.range.start.line !== line) {
                return false;
            }

            return diagnostic.message.toLowerCase().includes(`package '${packageId.toLowerCase()}'`);
        });
    }

    private createDiagnostic(
        line: number,
        text: string,
        pkg: PackageInfo,
        transitive: boolean,
        origin?: TransitiveOrigin,
        projectName?: string
    ): vscode.Diagnostic {
        const version = (projectName ? ScanState.resolvedVersionIn(pkg.id, projectName) : undefined) || pkg.version;
        const end = Math.max(text.length, 1);
        const range = new vscode.Range(line, 0, line, end);
        const code = auditCodeForSeverity(pkg.severity);
        const severityWord = (pkg.severity || "moderate").toLowerCase();
        const advisory = pkg.advisoryUrl ? `, ${pkg.advisoryUrl}` : "";
        const via = transitive && origin?.broughtBy && !origin.absentFromGraph
            ? ` via ${origin.broughtBy}`
            : "";
        const transitiveWord = transitive ? ` is transitive${via} and` : "";
        const pruned = transitive && origin?.absentFromGraph
            ? ". this warning may be left over in the package graph"
            : "";
        const diagnostic = new vscode.Diagnostic(
            range,
            `Package '${pkg.id}' ${version}${transitiveWord} has a known ${severityWord} severity vulnerability${advisory}${pruned}`,
            vscode.DiagnosticSeverity.Warning
        );

        diagnostic.source = "PackageHub";
        diagnostic.code = pkg.advisoryUrl?.startsWith("https://")
            ? { value: code, target: vscode.Uri.parse(pkg.advisoryUrl) }
            : code;

        return diagnostic;
    }
}
