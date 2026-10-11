import * as fs from "fs/promises";
import * as vscode from "vscode";
import { PackageInfo, TransitiveOrigin } from "../models/PackageInfo";
import { originForProject } from "../services/TransitiveOrigin";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { logger } from "../utils/logger";
import { auditCodeForSeverity, readPackageRef } from "../utils/nugetAudit";

export class PackageAuditDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("packageHub");
    private affectedProjectPaths: string[] = [];

    constructor(private readonly scanner: WorkspaceScanner) { }

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

            if (uri.fsPath.toLowerCase().endsWith(".csproj") && diagnostics.length > 0) {
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
        logger.info(`NU190x tanı güncellendi. Etkilenen proje: ${this.affectedProjectPaths.length}`);
    }

    dispose(): void {
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
            const include = line.match(/Include\s*=\s*"([^"]+)"/i);
            if (!include) {
                return false;
            }

            const value = include[1].toLowerCase();
            return value === needle
                || value.endsWith(`/${needle}.csproj`)
                || value.endsWith(`\\${needle}.csproj`)
                || value.endsWith(`${needle}.csproj`);
        });

        return index >= 0 ? index : 0;
    }

    private async diagnosticsForFile(
        uri: vscode.Uri,
        vulnerable: PackageInfo[]
    ): Promise<vscode.Diagnostic[]> {
        let text = "";
        try {
            text = await fs.readFile(uri.fsPath, "utf8");
        } catch (error: any) {
            logger.error(`Tanı için dosya okunamadı (${uri.fsPath}): ${error.message}`);
            return [];
        }

        const lines = text.split(/\r?\n/);
        const diagnostics: vscode.Diagnostic[] = [];
        const seen = new Set<string>();
        const isProject = uri.fsPath.toLowerCase().endsWith(".csproj");
        const projectName = isProject ? this.scanner.getProjectName(uri) : undefined;

        lines.forEach((line, index) => {
            const ref = readPackageRef(line);
            if (!ref) {
                return;
            }

            const pkg = vulnerable.find((item) => item.id.toLowerCase() === ref.id.toLowerCase());
            if (!pkg) {
                return;
            }

            if (projectName && !this.packageInProject(pkg, projectName)) {
                return;
            }

            if (this.lineAlreadyReported(uri, index, pkg.id)) {
                return;
            }

            diagnostics.push(this.createDiagnostic(index, line, pkg, false));
            seen.add(pkg.id.toLowerCase());
        });

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

                diagnostics.push(this.createDiagnostic(line, lines[line] || "", pkg, true, origin));
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
        origin?: TransitiveOrigin
    ): vscode.Diagnostic {
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
            ? ". bu uyarı paket grafiğinde kalmış olabilir"
            : "";
        const diagnostic = new vscode.Diagnostic(
            range,
            `Package '${pkg.id}' ${pkg.version}${transitiveWord} has a known ${severityWord} severity vulnerability${advisory}${pruned}`,
            vscode.DiagnosticSeverity.Warning
        );

        diagnostic.source = "PackageHub";
        diagnostic.code = pkg.advisoryUrl?.startsWith("https://")
            ? { value: code, target: vscode.Uri.parse(pkg.advisoryUrl) }
            : code;

        return diagnostic;
    }
}
