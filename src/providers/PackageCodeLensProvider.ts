import * as vscode from "vscode";
import { isMsBuildProject } from "../services/projectFiles";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { readPackageRefs } from "../utils/nugetAudit";
import { PackageCodeActionProvider } from "./PackageCodeActionProvider";

export function resolveLensPatch(
    stored: string | undefined,
    peeked: { ready: boolean; patch?: string }
): string | undefined {
    if (peeked.ready) {
        return peeked.patch;
    }

    return stored;
}

export class PackageCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;

    constructor(
        private readonly versions: PackageCodeActionProvider,
        private readonly scanner: WorkspaceScanner
    ) { }

    refresh(): void {
        this.emitter.fire();
    }

    dispose(): void {
        this.emitter.dispose();
    }

    async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        if (!ScanState.getScannedAt()) {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];

        const projectName = isMsBuildProject(document.fileName)
            ? this.scanner.getProjectName(document.uri)
            : undefined;

        for (const ref of readPackageRefs(document.getText())) {
            if (token.isCancellationRequested) {
                return lenses;
            }
            const line = ref.line;

            const found = ScanState.findPackage(ref.id);
            if (!found.vulnerable && !found.outdated) {
                continue;
            }

            const currentVersion = ScanState.resolvedVersionIn(ref.id, projectName)
                || found.vulnerable?.version
                || found.outdated?.version
                || ref.version;
            const stored = found.vulnerable?.highestPatch || found.outdated?.highestPatch;
            const peek = await this.versions.peekUpdateTargets(document, ref.id, currentVersion);
            const patch = resolveLensPatch(stored, peek);
            const lens = this.lensFor(document, line, ref.id, found.vulnerable?.severity, patch, peek.ready);
            if (lens) {
                lenses.push(lens);
            }
        }

        return lenses;
    }

    private lensFor(
        document: vscode.TextDocument,
        line: number,
        packageId: string,
        severity: string | undefined,
        patch: string | undefined,
        ready: boolean
    ): vscode.CodeLens | undefined {
        const range = document.lineAt(line).range;
        const projectName = isMsBuildProject(document.fileName)
            ? this.scanner.getProjectName(document.uri)
            : undefined;

        if (patch) {
            const title = severity
                ? `⚠ ${severity} · patch ${patch}`
                : `↑ ${patch}`;
            return new vscode.CodeLens(range, {
                title,
                command: "packageHub.updateVulnerable",
                arguments: [{
                    packageId,
                    version: patch,
                    ...(projectName ? { projectName } : {}),
                }],
            });
        }

        if (!severity) {
            return undefined;
        }

        return new vscode.CodeLens(range, {
            title: `⚠ ${severity}`,
            command: ready ? "packageHub.quickFixBlocked" : "packageHub.codeLensPending",
            arguments: [ready
                ? `No patch version for ${packageId}. The update was not started.`
                : undefined],
        });
    }
}
