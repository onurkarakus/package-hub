import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { DotnetCli } from "../services/DotnetCli";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { logger } from "../utils/logger";
import {
    advisoryUrlIn,
    chooseQuickFixVersions,
    isAuditCode,
    parseAdvisoryPackage,
    readDiagnosticCode,
    readPackageRef,
} from "../utils/nugetAudit";

interface VersionLists {
    at: number;
    patch: PackageInfo[];
    latest: PackageInfo[];
}

export class PackageCodeActionProvider implements vscode.CodeActionProvider {
    private readonly cache = new Map<string, VersionLists>();
    private readonly inflight = new Map<string, Promise<VersionLists | undefined>>();

    constructor(
        private readonly dotnetCli: DotnetCli,
        private readonly scanner: WorkspaceScanner
    ) { }

    clearCache(): void {
        this.cache.clear();
    }

    async peekUpdateTargets(
        document: vscode.TextDocument,
        packageId: string,
        currentVersion: string | undefined
    ): Promise<{ ready: boolean; patch?: string; latest?: string }> {
        const lists = await this.peekLists(document, packageId);
        if (!lists) {
            return { ready: false };
        }

        const current = ScanState.findPackage(packageId);
        const targets = chooseQuickFixVersions(
            currentVersion,
            this.versionFrom(lists.patch, packageId),
            this.versionFrom(lists.latest, packageId) || current.outdated?.latestVersion
        );

        return {
            ready: true,
            patch: targets.patch,
            latest: targets.latest,
        };
    }

    async prefetch(projectPaths: string[]): Promise<void> {
        const pending = [...new Set(projectPaths)];

        for (let index = 0; index < pending.length; index += 2) {
            const batch = pending.slice(index, index + 2);
            await Promise.all(batch.map(async (projectPath) => {
                try {
                    await this.cachedLists(projectPath);
                } catch (error: any) {
                    logger.error(`Patch sürümü okunamadı (${projectPath}): ${error.message}`);
                }
            }));
        }
    }

    async provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        const auditDiagnostics = context.diagnostics.filter((diagnostic) =>
            isAuditCode(readDiagnosticCode(diagnostic.code))
        );

        if (auditDiagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        const seen = new Set<string>();

        for (const diagnostic of auditDiagnostics) {
            const fromMessage = parseAdvisoryPackage(diagnostic.message);
            const line = document.lineAt(diagnostic.range.start.line).text;
            const onLine = readPackageRef(line);
            const packageId = fromMessage?.id || onLine?.id;

            if (!packageId || seen.has(packageId.toLowerCase())) {
                continue;
            }

            seen.add(packageId.toLowerCase());
            const direct = !!onLine && onLine.id.toLowerCase() === packageId.toLowerCase();
            actions.push(...await this.actionsForPackage(document, packageId, direct, diagnostic, token));
        }

        return actions;
    }

    private async actionsForPackage(
        document: vscode.TextDocument,
        packageId: string,
        direct: boolean,
        diagnostic: vscode.Diagnostic,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        if (!ScanState.getScannedAt()) {
            return [this.commandAction(
                "PackageHub: Scan required before update",
                "packageHub.scanWorkspace",
                [],
                false
            )];
        }

        if (token.isCancellationRequested) {
            return [];
        }

        const projectPath = await this.projectPathFor(document, packageId);
        let lists: VersionLists | undefined;

        if (projectPath) {
            try {
                lists = await this.cachedLists(projectPath);
            } catch (error: any) {
                logger.error(`Quick Fix sürüm okunamadı (${packageId}): ${error.message}`);
            }
        }

        const current = ScanState.findPackage(packageId);
        const lineVersion = readPackageRef(
            document.lineAt(diagnostic.range.start.line).text
        )?.version;
        const currentVersion = lineVersion || current.vulnerable?.version || current.outdated?.version;
        const targets = chooseQuickFixVersions(
            currentVersion,
            this.versionFrom(lists?.patch, packageId),
            this.versionFrom(lists?.latest, packageId) || current.outdated?.latestVersion
        );
        const projectName = document.fileName.toLowerCase().endsWith(".csproj")
            ? this.scanner.getProjectName(document.uri)
            : undefined;
        const actions: vscode.CodeAction[] = [];

        if (targets.patch) {
            const title = direct
                ? `PackageHub: Update to highest patch ${targets.patch}`
                : `PackageHub: Pin ${packageId} at ${targets.patch} (transitive)`;
            actions.push(this.commandAction(
                title,
                "packageHub.updateVulnerable",
                [{ packageId, version: targets.patch, projectName }],
                true
            ));
        }

        if (targets.latest) {
            const title = direct
                ? `PackageHub: Update to latest ${targets.latest}`
                : `PackageHub: Pin ${packageId} at latest ${targets.latest} (transitive)`;
            actions.push(this.commandAction(
                title,
                "packageHub.updateVulnerable",
                [{ packageId, version: targets.latest, projectName }],
                !targets.patch
            ));
        }

        if (!targets.patch && !targets.latest) {
            actions.push(this.commandAction(
                `PackageHub: No patch version for ${packageId}. Update was not started.`,
                "packageHub.quickFixBlocked",
                [`${packageId} için patch sürümü yok. Güncelleme başlatılmadı.`],
                false
            ));
        }

        const advisory = current.vulnerable?.advisoryUrl || advisoryUrlIn(diagnostic.message);
        if (advisory) {
            actions.push(this.commandAction(
                "PackageHub: Open Advisory",
                "packageHub.openAdvisory",
                [advisory],
                false
            ));
        }

        return actions;
    }

    private versionFrom(packages: PackageInfo[] | undefined, packageId: string): string | undefined {
        return packages?.find((item) => item.id.toLowerCase() === packageId.toLowerCase())?.latestVersion;
    }

    private commandAction(
        title: string,
        command: string,
        args: unknown[],
        preferred: boolean
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.command = { command, title, arguments: args };
        action.isPreferred = preferred;
        return action;
    }

    private async projectPathFor(
        document: vscode.TextDocument,
        packageId: string
    ): Promise<string | undefined> {
        if (document.fileName.toLowerCase().endsWith(".csproj")) {
            return document.uri.fsPath;
        }

        const found = ScanState.findPackage(packageId);
        const names = found.vulnerable?.projects || found.outdated?.projects || [];
        const projects = await this.scanner.findProjects();
        const match = projects.find((project) =>
            names.some((name) => name.toLowerCase() === this.scanner.getProjectName(project).toLowerCase())
        );

        return match?.fsPath;
    }

    private async peekLists(
        document: vscode.TextDocument,
        packageId: string
    ): Promise<VersionLists | undefined> {
        if (document.fileName.toLowerCase().endsWith(".csproj")) {
            return this.peekProject(document.uri.fsPath);
        }

        const named = this.freshCaches().find((lists) =>
            this.versionFrom(lists.patch, packageId) || this.versionFrom(lists.latest, packageId)
        );
        if (named) {
            return named;
        }

        const only = this.freshCaches();
        if (only.length === 1) {
            return only[0];
        }

        if (this.inflight.size === 0) {
            return undefined;
        }

        await Promise.allSettled(this.inflight.values());
        const after = this.freshCaches();
        return after.find((lists) =>
            this.versionFrom(lists.patch, packageId) || this.versionFrom(lists.latest, packageId)
        ) || (after.length === 1 ? after[0] : undefined);
    }

    private async peekProject(projectPath: string): Promise<VersionLists | undefined> {
        const cached = this.freshLists(this.cache.get(projectPath));
        if (cached) {
            return cached;
        }

        const pending = this.inflight.get(projectPath);
        if (!pending) {
            return undefined;
        }

        try {
            return this.freshLists(await pending);
        } catch {
            return undefined;
        }
    }

    private freshCaches(): VersionLists[] {
        return [...this.cache.values()].filter((lists): lists is VersionLists => !!this.freshLists(lists));
    }

    private freshLists(lists: VersionLists | undefined): VersionLists | undefined {
        if (!lists || Date.now() - lists.at >= 5 * 60 * 1000) {
            return undefined;
        }

        return lists;
    }

    private cachedLists(projectPath: string): Promise<VersionLists | undefined> {
        const hit = this.cache.get(projectPath);
        if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
            return Promise.resolve(hit);
        }

        const pending = this.inflight.get(projectPath);
        if (pending) {
            return pending;
        }

        const job = this.fetchLists(projectPath)
            .finally(() => {
                this.inflight.delete(projectPath);
            });
        this.inflight.set(projectPath, job);
        return job;
    }

    private async fetchLists(projectPath: string): Promise<VersionLists | undefined> {
        const [patch, latest] = await Promise.all([
            this.dotnetCli.listOutdated(projectPath, true, "patch"),
            this.dotnetCli.listOutdated(projectPath, true, "latest"),
        ]);

        const lists: VersionLists = { at: Date.now(), patch, latest };
        this.cache.set(projectPath, lists);
        return lists;
    }
}
