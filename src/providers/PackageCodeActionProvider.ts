import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { DotnetCli } from "../services/DotnetCli";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { advisoryVerdict, firstFixedVersion } from "../services/AdvisoryCatalog";
import { latestReleasePreferred } from "../services/ReleaseAge";
import { isMsBuildProject } from "../services/projectFiles";
import { originForProject } from "../services/TransitiveOrigin";
import { highestPatchFromLocal } from "../services/PatchFallback";
import { logger } from "../utils/logger";
import {
    advisoryUrlIn,
    chooseQuickFixVersions,
    isAuditCode,
    parseAdvisoryPackage,
    readDiagnosticCode,
    packageRefAtLine,
    sameNuGetVersion,
} from "../utils/nugetAudit";

interface VersionLists {
    at: number;
    patch: PackageInfo[];
    latest: PackageInfo[];
    /** False when the lists came from a scan that read direct packages only. */
    includesTransitive: boolean;
}

const CACHE_MS = 5 * 60 * 1000;

export class PackageCodeActionProvider implements vscode.CodeActionProvider {
    private readonly cache = new Map<string, VersionLists>();
    private readonly inflight = new Map<string, Promise<VersionLists | undefined>>();
    /** Bumped by clearCache(). A fetch that started earlier does not fill the cache. */
    private generation = 0;

    constructor(
        private readonly dotnetCli: DotnetCli,
        private readonly scanner: WorkspaceScanner
    ) { }

    clearCache(): void {
        this.generation += 1;
        this.cache.clear();
        this.inflight.clear();
    }

    /**
     * Stores lists a scan already read, so the lightbulb does not run the same
     * dotnet commands again.
     */
    seed(projectPath: string, patch: PackageInfo[], latest: PackageInfo[], includesTransitive: boolean): void {
        const known = this.cache.get(projectPath);
        if (known && known.includesTransitive && !includesTransitive && Date.now() - known.at < CACHE_MS) {
            return;
        }
        this.cache.set(projectPath, { at: Date.now(), patch, latest, includesTransitive });
    }

    async peekUpdateTargets(
        document: vscode.TextDocument,
        packageId: string,
        currentVersion: string | undefined
    ): Promise<{ ready: boolean; patch?: string; latest?: string; latestPreferred?: boolean }> {
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
            latestPreferred: targets.latest
                ? latestReleasePreferred(packageId, targets.latest)
                : true,
        };
    }

    /**
     * Reads the lists for projects that need them. Projects whose vulnerable
     * packages are all direct reuse what the scan read.
     */
    async prefetch(projectPaths: string[], needsTransitive: (projectPath: string) => boolean = () => true): Promise<void> {
        const pending = [...new Set(projectPaths)];

        for (let index = 0; index < pending.length; index += 2) {
            const batch = pending.slice(index, index + 2);
            await Promise.all(batch.map(async (projectPath) => {
                try {
                    await this.cachedLists(projectPath, needsTransitive(projectPath));
                } catch (error: any) {
                    logger.error(`Could not read the patch version (${projectPath}): ${error.message}`);
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
            const onLine = packageRefAtLine(document.getText(), diagnostic.range.start.line);
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
                logger.error(`Could not read the Quick Fix version (${packageId}): ${error.message}`);
            }
        }

        const current = ScanState.findPackage(packageId);
        const projectName = isMsBuildProject(document.fileName)
            ? this.scanner.getProjectName(document.uri)
            : undefined;
        const lineVersion = packageRefAtLine(document.getText(), diagnostic.range.start.line)?.version;
        const currentVersion = ScanState.resolvedVersionIn(packageId, projectName)
            || current.vulnerable?.version
            || current.outdated?.version
            || lineVersion;
        const targets = chooseQuickFixVersions(
            currentVersion,
            this.versionFrom(lists?.patch, packageId),
            this.versionFrom(lists?.latest, packageId) || current.outdated?.latestVersion
        );
        const advisory = current.vulnerable?.advisoryUrl || advisoryUrlIn(diagnostic.message);
        const actions: vscode.CodeAction[] = [];
        const origin = originForProject(current.vulnerable, projectName);

        if (origin?.absentFromGraph) {
            actions.push(this.commandAction(
                "PackageHub: this warning may be left over in the package graph",
                "packageHub.quickFixBlocked",
                ["this warning may be left over in the package graph"],
                false
            ));
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

        const parentUpdate = !direct
            ? this.parentPackageUpdate(origin, lists)
            : undefined;
        const owningProject = !direct && !parentUpdate
            ? this.owningProject(origin, current.vulnerable?.projects, projectName)
            : undefined;
        const ownsPatch = !!(owningProject && targets.patch);

        if (parentUpdate) {
            actions.push(this.commandAction(
                `PackageHub: Update ${parentUpdate.id} to highest patch ${parentUpdate.version}`,
                "packageHub.updateVulnerable",
                [{ packageId: parentUpdate.id, version: parentUpdate.version, projectName }],
                true
            ));
        }

        if (ownsPatch && owningProject && targets.patch) {
            const base = `PackageHub: Update ${packageId} in ${owningProject} to highest patch ${targets.patch}`;
            actions.push(this.commandAction(
                this.withVerdict(base, packageId, advisory, targets.patch),
                "packageHub.updateVulnerable",
                [{ packageId, version: targets.patch, projectName: owningProject }],
                true
            ));
        }

        if (targets.patch) {
            const base = direct
                ? `PackageHub: Update to highest patch ${targets.patch}`
                : `PackageHub: Pin ${packageId} at ${targets.patch} (transitive)`;
            actions.push(this.commandAction(
                this.withVerdict(base, packageId, advisory, targets.patch),
                "packageHub.updateVulnerable",
                [{ packageId, version: targets.patch, projectName }],
                !parentUpdate && !ownsPatch
            ));
        }

        if (targets.latest) {
            const base = direct
                ? `PackageHub: Update to latest ${targets.latest}`
                : `PackageHub: Pin ${packageId} at latest ${targets.latest} (transitive)`;
            const mature = latestReleasePreferred(packageId, targets.latest);
            const title = this.withVerdict(base, packageId, advisory, targets.latest);
            actions.push(this.commandAction(
                mature ? title : `${title}, younger than the age gate`,
                "packageHub.updateVulnerable",
                [{ packageId, version: targets.latest, projectName }],
                !targets.patch && !parentUpdate && !ownsPatch && mature
            ));
        }

        const fixed = firstFixedVersion(packageId, advisory, currentVersion);
        const showFixed = !!fixed
            && !sameNuGetVersion(fixed, targets.patch)
            && !sameNuGetVersion(fixed, targets.latest);
        if (fixed && showFixed) {
            const base = direct
                ? `PackageHub: Update to first fixed version ${fixed}`
                : `PackageHub: Pin ${packageId} at first fixed ${fixed} (transitive)`;
            actions.push(this.commandAction(
                this.withVerdict(base, packageId, advisory, fixed),
                "packageHub.updateVulnerable",
                [{ packageId, version: fixed, projectName }],
                false
            ));
        }

        if (!targets.patch && !targets.latest && !showFixed && !parentUpdate) {
            actions.push(this.commandAction(
                `PackageHub: No patch version for ${packageId}. Update was not started.`,
                "packageHub.quickFixBlocked",
                [`No patch version for ${packageId}. The update was not started.`],
                false
            ));
        }

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

    private parentPackageUpdate(
        origin: { broughtBy?: string; broughtByKind?: "package" | "project" } | undefined,
        lists: VersionLists | undefined
    ): { id: string; version: string } | undefined {
        if (origin?.broughtByKind !== "package" || !origin.broughtBy) {
            return undefined;
        }

        const current = ScanState.findPackage(origin.broughtBy);
        const currentVersion = current.outdated?.version || current.vulnerable?.version;
        const patch = chooseQuickFixVersions(
            currentVersion,
            this.versionFrom(lists?.patch, origin.broughtBy),
            undefined
        ).patch;
        if (!patch) {
            return undefined;
        }

        return { id: origin.broughtBy, version: patch };
    }

    private owningProject(
        origin: { broughtBy?: string; broughtByKind?: "package" | "project" } | undefined,
        projects: string[] | undefined,
        currentProject: string | undefined
    ): string | undefined {
        if (origin?.broughtByKind !== "project" || !origin.broughtBy) {
            return undefined;
        }

        const owner = projects?.find((name) => name.toLowerCase() === origin.broughtBy?.toLowerCase());
        if (!owner || owner.toLowerCase() === currentProject?.toLowerCase()) {
            return undefined;
        }

        return owner;
    }

    private withVerdict(
        title: string,
        packageId: string,
        advisoryUrl: string | undefined,
        version: string
    ): string {
        const verdict = advisoryVerdict(packageId, advisoryUrl, version);
        if (verdict === "open") {
            return `${title}, advisory stays open`;
        }
        if (verdict === "closed") {
            return `${title}, advisory closes`;
        }
        return title;
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
        if (isMsBuildProject(document.fileName)) {
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
        if (isMsBuildProject(document.fileName)) {
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
        if (!lists || Date.now() - lists.at >= CACHE_MS) {
            return undefined;
        }

        return lists;
    }

    private cachedLists(projectPath: string, needsTransitive = true): Promise<VersionLists | undefined> {
        const hit = this.cache.get(projectPath);
        if (hit && Date.now() - hit.at < CACHE_MS && (hit.includesTransitive || !needsTransitive)) {
            return Promise.resolve(hit);
        }

        const pending = this.inflight.get(projectPath);
        if (pending) {
            return pending;
        }

        const job = this.fetchLists(projectPath)
            .finally(() => {
                if (this.inflight.get(projectPath) === job) {
                    this.inflight.delete(projectPath);
                }
            });
        this.inflight.set(projectPath, job);
        return job;
    }

    private async fetchLists(projectPath: string): Promise<VersionLists | undefined> {
        const generation = this.generation;
        const prerelease = ScanState.includePrerelease();
        const [patchResult, latestResult] = await Promise.allSettled([
            this.dotnetCli.listOutdated(projectPath, true, "patch", undefined, prerelease),
            this.dotnetCli.listOutdated(projectPath, true, "latest", undefined, prerelease),
        ]);
        if (latestResult.status === "rejected") {
            throw latestResult.reason;
        }
        const latest = latestResult.value;
        let patch: PackageInfo[];
        if (patchResult.status === "fulfilled") {
            patch = patchResult.value;
        } else {
            logger.info(`dotnet could not list the highest patch for ${projectPath} (${patchResult.reason?.message || patchResult.reason}). Using the local version list.`);
            patch = await highestPatchFromLocal(latest, prerelease);
        }

        const lists: VersionLists = { at: Date.now(), patch, latest, includesTransitive: true };
        if (generation !== this.generation) {
            // A scan cleared the cache while this ran. Its data may be stale.
            return lists;
        }
        this.cache.set(projectPath, lists);
        return lists;
    }
}
