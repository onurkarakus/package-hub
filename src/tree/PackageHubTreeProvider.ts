import * as fs from "fs/promises";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { directProjectNames, formatProjectRelations, transitiveCaption } from "../services/TransitiveOrigin";
import { getFeedHealth } from "../services/FeedHealth";
import { welcomeState } from "../services/welcomeState";
import { readPackageRefs, severityRank as severityLevel } from "../utils/nugetAudit";
import { badgeMode } from "../services/Settings";

const errorColor = new vscode.ThemeColor("problemsErrorIcon.foreground");
const warningColor = new vscode.ThemeColor("problemsWarningIcon.foreground");
const infoColor = new vscode.ThemeColor("problemsInfoIcon.foreground");
const passColor = new vscode.ThemeColor("testing.iconPassed");

type ItemOptions = {
    command?: vscode.Command;
    description?: string;
    packageId?: string;
    latestVersion?: string;
    projectPath?: string;
    icon?: vscode.ThemeIcon;
    tooltip?: string | vscode.MarkdownString;
    resourceUri?: vscode.Uri;
    /** Stable key of a section node, independent of the display language. */
    sectionKey?: string;
    contextValue?: string;
};

export class PackageHubTreeItem extends vscode.TreeItem {
    public readonly packageId?: string;
    public readonly latestVersion?: string;
    public readonly projectPath?: string;
    public readonly sectionKey?: string;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        options?: ItemOptions
    ) {
        super(label, collapsibleState);
        this.packageId = options?.packageId;
        this.latestVersion = options?.latestVersion;
        this.projectPath = options?.projectPath;
        this.sectionKey = options?.sectionKey;

        if (options?.description) {
            this.description = options.description;
        }
        if (options?.command) {
            this.command = options.command;
        }
        if (options?.icon) {
            this.iconPath = options.icon;
        }
        if (options?.tooltip) {
            this.tooltip = options.tooltip;
        }
        if (options?.resourceUri) {
            this.resourceUri = options.resourceUri;
        }
        if (options?.packageId) {
            this.contextValue = options.contextValue ?? "packageHub.package";
        }
    }
}

let sharedScanner: WorkspaceScanner = new WorkspaceScanner();

export class PackageHubTreeProvider
    implements vscode.TreeDataProvider<PackageHubTreeItem> {
    private view?: vscode.TreeView<PackageHubTreeItem>;

    constructor(scanner?: WorkspaceScanner) {
        if (scanner) {
            sharedScanner = scanner;
        }
    }
    private _onDidChangeTreeData = new vscode.EventEmitter<
        PackageHubTreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    attach(view: vscode.TreeView<PackageHubTreeItem>): void {
        this.view = view;
        this.updateBadge();
    }

    refresh(): void {
        this.updateBadge();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PackageHubTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PackageHubTreeItem): Promise<PackageHubTreeItem[]> {
        const vulnerable = ScanState.getVulnerable();
        const outdated = ScanState.getOutDated();
        const deprecated = ScanState.getDeprecated();
        const conflicts = ScanState.getVersionConflicts();

        let rootProjects: vscode.Uri[] | undefined;
        if (!element) {
            // An empty root lets the welcome view (viewsWelcome) explain what to open.
            const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
            const found = folderCount > 0
                ? await sharedScanner.countScanTargets()
                : { projects: [] as vscode.Uri[], targets: 0 };
            rootProjects = found.projects;
            const state = welcomeState(folderCount, found.targets);
            void vscode.commands.executeCommand("setContext", "packageHub.noProjects", state === "noProjects");
            void vscode.commands.executeCommand("setContext", "packageHub.hasProjects", found.targets > 0);
            if (state) {
                return [];
            }
        }

        if (!element && !ScanState.getScannedAt()) {
            return [
                new PackageHubTreeItem(vscode.l10n.t("Scan Now"), vscode.TreeItemCollapsibleState.None, {
                    command: {
                        command: "packageHub.scanWorkspace",
                        title: vscode.l10n.t("Scan Workspace"),
                    },
                    description: vscode.l10n.t("Not scanned"),
                    icon: new vscode.ThemeIcon("search"),
                }),
            ];
        }

        if (!element) {
            const projects = rootProjects ?? await sharedScanner.findProjects();
            const feeds = getFeedHealth();
            const failingFeeds = feeds.statuses.filter((status) => status.enabled && status.failures.length > 0).length
                + (feeds.unmatched.length > 0 ? 1 : 0);
            const expandProjects = projects.length > 0 && projects.length <= 4 && vulnerable.length > 0;
            return [
                section("Vulnerable", vscode.l10n.t("Vulnerable"), vulnerable.length, vulnerable.length > 0, new vscode.ThemeIcon("error", errorColor)),
                section("Outdated", vscode.l10n.t("Outdated"), outdated.length, vulnerable.length === 0 && outdated.length > 0, new vscode.ThemeIcon("arrow-circle-up", warningColor)),
                section("Deprecated", vscode.l10n.t("Deprecated"), deprecated.length, false, new vscode.ThemeIcon("archive", warningColor)),
                section("Conflicts", vscode.l10n.t("Conflicts"), conflicts.length, false, new vscode.ThemeIcon("diff", warningColor)),
                section(
                    "Projects",
                    vscode.l10n.t("Projects"),
                    projects.length,
                    expandProjects,
                    new vscode.ThemeIcon("project"),
                    projects.length > 0
                ),
                new PackageHubTreeItem(vscode.l10n.t("Feeds"), vscode.TreeItemCollapsibleState.Collapsed, {
                    sectionKey: "Feeds",
                    description: feeds.sources
                        ? `${vscode.l10n.t("{0} enabled", feeds.sources.filter((source) => source.enabled).length)}${failingFeeds > 0 ? ` · ${vscode.l10n.t("{0} failed", failingFeeds)}` : ""}`
                        : vscode.l10n.t("Not read"),
                    icon: failingFeeds > 0
                        ? new vscode.ThemeIcon("warning", warningColor)
                        : new vscode.ThemeIcon("cloud"),
                    tooltip: vscode.l10n.t("Package sources dotnet uses, and failures from the last scan or restore."),
                }),
                new PackageHubTreeItem(vscode.l10n.t("Actions"), vscode.TreeItemCollapsibleState.Collapsed, {
                    sectionKey: "Actions",
                    icon: new vscode.ThemeIcon("tools"),
                }),
            ];
        }

        if (element.projectPath) {
            return packagesForProject(element.projectPath);
        }

        if (element.sectionKey === "Projects") {
            return projectNodes();
        }

        if (element.sectionKey === "Vulnerable") {
            if (vulnerable.length === 0) {
                return [emptyItem(vscode.l10n.t("No vulnerable packages"))];
            }

            return [...vulnerable]
                .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.id.localeCompare(right.id))
                .map((pkg) => packageItem(pkg.id, vulnerableDescription(pkg), severityIcon(pkg.severity), pkg.latestVersion));
        }

        if (element.sectionKey === "Outdated") {
            if (outdated.length === 0) {
                return [emptyItem(vscode.l10n.t("No outdated packages"))];
            }

            return [...outdated]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((pkg) => packageItem(
                    pkg.id,
                    `${packageVersionText(pkg.id, pkg.version)} → ${pkg.latestVersion || "?"}`,
                    new vscode.ThemeIcon("arrow-circle-up", warningColor),
                    pkg.latestVersion
                ));
        }

        if (element.sectionKey === "Deprecated") {
            if (deprecated.length === 0) {
                return [emptyItem(vscode.l10n.t("No deprecated packages"))];
            }

            return [...deprecated]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((pkg) => packageItem(
                    pkg.id,
                    packageVersionText(pkg.id, pkg.version),
                    new vscode.ThemeIcon("archive", warningColor),
                    pkg.latestVersion
                ));
        }

        if (element.sectionKey === "Conflicts") {
            if (conflicts.length === 0) {
                return [emptyItem(vscode.l10n.t("No version conflicts"))];
            }

            return conflicts.map(
                (conflict) => packageItem(
                    conflict.id,
                    conflict.versions.map((version) => version.version).join(" / "),
                    new vscode.ThemeIcon("diff", warningColor),
                    undefined,
                    "packageHub.package.conflict"
                )
            );
        }

        if (element.sectionKey === "Feeds") {
            return feedNodes();
        }

        if (element.sectionKey === "Actions") {
            return [
                action(vscode.l10n.t("Scan Now"), "packageHub.scanWorkspace", "search"),
                action(vscode.l10n.t("Open Dashboard"), "packageHub.showHealthDashboard", "dashboard"),
                action(vscode.l10n.t("Add Package"), "packageHub.addPackage", "add"),
                action(vscode.l10n.t("Align Versions"), "packageHub.alignVersions", "git-merge"),
                action(vscode.l10n.t("Remove Unused Central Versions"), "packageHub.removeUnusedCentralVersions", "trash"),
                action(vscode.l10n.t("Copy Health Report"), "packageHub.copyHealthReport", "notebook"),
                action(vscode.l10n.t("Copy Vulnerability Report"), "packageHub.copyVulnerabilityReport", "shield"),
                action(vscode.l10n.t("Restore All"), "packageHub.restoreAll", "cloud-download"),
            ];
        }

        return [];
    }

    private updateBadge(): void {
        if (!this.view) {
            return;
        }

        const mode = badgeMode();
        if (mode === "off" || !ScanState.getScannedAt()) {
            this.view.badge = undefined;
            return;
        }
        const vulnerable = ScanState.getVulnerable().length;
        const outdated = mode === "vulnerable" ? 0 : ScanState.getOutDated().length;
        const deprecated = mode === "all" ? ScanState.getDeprecated().length : 0;
        const count = vulnerable + outdated + deprecated;
        const parts = [
            vscode.l10n.t("{0} vulnerable", vulnerable),
            ...(mode !== "vulnerable" ? [vscode.l10n.t("{0} outdated", outdated)] : []),
            ...(mode === "all" ? [vscode.l10n.t("{0} deprecated", deprecated)] : []),
        ];
        this.view.badge = count > 0
            ? { value: count, tooltip: parts.join(" · ") }
            : undefined;
    }
}

function section(
    key: string,
    label: string,
    count: number,
    expanded: boolean,
    activeIcon: vscode.ThemeIcon,
    alwaysActive = false
): PackageHubTreeItem {
    const open = expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    return new PackageHubTreeItem(label, open, {
        sectionKey: key,
        description: String(count),
        icon: count > 0 || alwaysActive ? activeIcon : new vscode.ThemeIcon("check", passColor),
        tooltip: `${label}: ${count}`,
    });
}

function action(label: string, command: string, icon: string): PackageHubTreeItem {
    return new PackageHubTreeItem(label, vscode.TreeItemCollapsibleState.None, {
        command: { command, title: label },
        icon: new vscode.ThemeIcon(icon),
    });
}

function emptyItem(label: string): PackageHubTreeItem {
    return new PackageHubTreeItem(label, vscode.TreeItemCollapsibleState.None, {
        icon: new vscode.ThemeIcon("check", passColor),
    });
}

function packageItem(
    id: string,
    description: string,
    icon: vscode.ThemeIcon,
    latestVersion?: string,
    contextValue?: string
): PackageHubTreeItem {
    const found = ScanState.findPackage(id);
    const latest = latestVersion || found.outdated?.latestVersion || found.vulnerable?.latestVersion;
    return new PackageHubTreeItem(id, vscode.TreeItemCollapsibleState.None, {
        command: {
            command: "packageHub.revealPackage",
            title: vscode.l10n.t("Open Package"),
            arguments: [{ packageId: id }],
        },
        description,
        packageId: id,
        contextValue,
        latestVersion: latest,
        icon,
        tooltip: packageTooltip(id, description),
    });
}

async function projectNodes(): Promise<PackageHubTreeItem[]> {
    const scanner = sharedScanner;
    const projects = await scanner.findProjects();
    projects.sort((left, right) =>
        scanner.getProjectName(left).localeCompare(scanner.getProjectName(right))
    );

    if (projects.length === 0) {
        return [
            new PackageHubTreeItem(vscode.l10n.t("No projects"), vscode.TreeItemCollapsibleState.None, {
                icon: new vscode.ThemeIcon("info", infoColor),
            }),
        ];
    }

    const items: PackageHubTreeItem[] = [];
    for (const project of projects) {
        const name = scanner.getProjectName(project);
        const rows = await readProjectPackages(project.fsPath);
        items.push(new PackageHubTreeItem(name, vscode.TreeItemCollapsibleState.Collapsed, {
            projectPath: project.fsPath,
            resourceUri: project,
            description: rows ? projectHealthText(rows) : vscode.l10n.t("Could not read the csproj."),
            icon: rows ? projectIcon(rows) : new vscode.ThemeIcon("error", errorColor),
            tooltip: project.fsPath,
        }));
    }
    return items;
}

async function packagesForProject(projectPath: string): Promise<PackageHubTreeItem[]> {
    const rows = await readProjectPackages(projectPath);
    if (!rows) {
        return [
            new PackageHubTreeItem(vscode.l10n.t("Could not read the csproj."), vscode.TreeItemCollapsibleState.None, {
                icon: new vscode.ThemeIcon("error", errorColor),
            }),
        ];
    }

    const list = [...rows].sort((left, right) => {
        const rank = packageRank(left.id) - packageRank(right.id);
        return rank || left.id.localeCompare(right.id);
    });

    if (list.length === 0) {
        return [
            new PackageHubTreeItem(vscode.l10n.t("No packages"), vscode.TreeItemCollapsibleState.None, {
                icon: new vscode.ThemeIcon("info", infoColor),
                tooltip: vscode.l10n.t("No PackageReference in this file."),
            }),
        ];
    }

    return list.map((pkg) => projectPackageItem(pkg.id, pkg.version));
}

async function readProjectPackages(
    projectPath: string
): Promise<{ id: string; version?: string }[] | undefined> {
    let text = "";
    try {
        text = await fs.readFile(projectPath, "utf8");
    } catch {
        return undefined;
    }

    const packages = new Map<string, { id: string; version?: string }>();
    for (const ref of readPackageRefs(text)) {
        if (ref.kind !== "reference") {
            continue;
        }
        const key = ref.id.toLowerCase();
        if (packages.has(key)) {
            continue;
        }
        packages.set(key, {
            id: ref.id,
            version: ref.version || ScanState.getCentralVersion(ref.id),
        });
    }

    return Array.from(packages.values());
}

function projectHealthText(rows: { id: string }[]): string {
    if (rows.length === 0) {
        return vscode.l10n.t("No packages");
    }

    let vulnerable = 0;
    let outdated = 0;
    let deprecated = 0;
    for (const row of rows) {
        const found = ScanState.findPackage(row.id);
        if (found.vulnerable) {
            vulnerable += 1;
        } else if (found.outdated) {
            outdated += 1;
        } else if (found.deprecated) {
            deprecated += 1;
        }
    }

    const parts: string[] = [];
    if (vulnerable > 0) {
        parts.push(vscode.l10n.t("{0} vulnerable", vulnerable));
    }
    if (outdated > 0) {
        parts.push(vscode.l10n.t("{0} outdated", outdated));
    }
    if (deprecated > 0) {
        parts.push(vscode.l10n.t("{0} deprecated", deprecated));
    }
    if (parts.length === 0) {
        return rows.length === 1 ? vscode.l10n.t("1 package") : vscode.l10n.t("{0} packages", rows.length);
    }
    return parts.join(" · ");
}

function projectIcon(rows: { id: string }[]): vscode.ThemeIcon {
    if (rows.some((row) => ScanState.findPackage(row.id).vulnerable)) {
        return new vscode.ThemeIcon("error", errorColor);
    }
    if (rows.some((row) => ScanState.findPackage(row.id).outdated || ScanState.findPackage(row.id).deprecated)) {
        return new vscode.ThemeIcon("warning", warningColor);
    }
    if (rows.length === 0) {
        return new vscode.ThemeIcon("project");
    }
    return new vscode.ThemeIcon("check", passColor);
}

function packageRank(id: string): number {
    const found = ScanState.findPackage(id);
    if (found.vulnerable) {
        return 0;
    }
    if (found.outdated) {
        return 1;
    }
    if (found.deprecated) {
        return 2;
    }
    return 3;
}

function projectPackageItem(id: string, version: string | undefined): PackageHubTreeItem {
    const found = ScanState.findPackage(id);
    const shown = packageVersionText(id, version);

    if (found.vulnerable) {
        return packageItem(
            id,
            `${shown}${found.vulnerable.severity ? " · " + found.vulnerable.severity : ""}`,
            severityIcon(found.vulnerable.severity),
            found.vulnerable.latestVersion
        );
    }

    if (found.outdated) {
        return packageItem(
            id,
            `${shown} → ${found.outdated.latestVersion || "?"}`,
            new vscode.ThemeIcon("arrow-circle-up", warningColor),
            found.outdated.latestVersion
        );
    }

    if (found.deprecated) {
        return packageItem(
            id,
            shown,
            new vscode.ThemeIcon("archive", warningColor),
            found.deprecated.latestVersion
        );
    }

    return packageItem(id, shown, new vscode.ThemeIcon("package"));
}

function vulnerableDescription(pkg: PackageInfo): string {
    const head = `${packageVersionText(pkg.id, pkg.version)}${pkg.severity ? " · " + pkg.severity : ""}`;
    const direct = directProjectNames(pkg);
    if (direct.length > 0) {
        return `${head} · ${direct.join(", ")}`;
    }

    const caption = transitiveCaption(pkg);
    return caption ? `${head} · ${caption}` : head;
}

function packageTooltip(id: string, description: string): vscode.MarkdownString {
    const found = ScanState.findPackage(id);
    const info = found.vulnerable || found.outdated || found.deprecated;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**");
    tooltip.appendText(id);
    tooltip.appendMarkdown("**");
    tooltip.appendMarkdown("\n\n");
    tooltip.appendText(description);

    if (info) {
        const relations = formatProjectRelations(info);
        if (relations && relations !== "—") {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(relations);
        }
        if (info.highestPatch) {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(vscode.l10n.t("Highest patch {0}", info.highestPatch));
        }
        if (info.latestVersion && info.latestVersion !== info.highestPatch) {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(vscode.l10n.t("Latest {0}", info.latestVersion));
        }
    }

    const advisory = found.vulnerable?.advisoryUrl;
    if (advisory && advisory.startsWith("https://") && !advisory.includes(" ")) {
        tooltip.appendMarkdown(`\n\n[${vscode.l10n.t("Advisory")}](${advisory})`);
    }

    tooltip.isTrusted = false;
    return tooltip;
}

/**
 * Sort order: critical first, unknown severity last.
 */
function severityRank(severity?: string): number {
    return 4 - severityLevel(severity);
}

function feedNodes(): PackageHubTreeItem[] {
    const state = getFeedHealth();
    if (!state.sources) {
        return [new PackageHubTreeItem(
            state.sourceError ? vscode.l10n.t("dotnet did not list the sources") : vscode.l10n.t("Scan to read the sources"),
            vscode.TreeItemCollapsibleState.None,
            { icon: new vscode.ThemeIcon("info", infoColor), tooltip: state.sourceError }
        )];
    }
    const items = state.statuses.map((status) => {
        const failed = status.failures.length > 0;
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendText(status.url);
        for (const failure of status.failures) {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(`${failure.code}: ${failure.message}`);
        }
        for (const hint of status.hints) {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(hint);
        }
        tooltip.isTrusted = false;
        return new PackageHubTreeItem(status.name, vscode.TreeItemCollapsibleState.None, {
            description: !status.enabled ? vscode.l10n.t("disabled") : failed ? vscode.l10n.t("failed ({0})", status.failures[0].code) : vscode.l10n.t("enabled"),
            icon: !status.enabled
                ? new vscode.ThemeIcon("circle-slash")
                : failed
                    ? new vscode.ThemeIcon("error", errorColor)
                    : new vscode.ThemeIcon("cloud"),
            tooltip,
        });
    });
    for (const failure of state.unmatched) {
        items.push(new PackageHubTreeItem(failure.code, vscode.TreeItemCollapsibleState.None, {
            description: failure.message,
            icon: new vscode.ThemeIcon("warning", warningColor),
            tooltip: failure.message,
        }));
    }
    if (items.length === 0) {
        items.push(emptyItem(vscode.l10n.t("No package sources")));
    }
    return items;
}

function severityIcon(severity?: string): vscode.ThemeIcon {
    const rank = (severity || "").toLowerCase();
    if (rank === "critical" || rank === "high") {
        return new vscode.ThemeIcon("error", errorColor);
    }
    if (rank === "low") {
        return new vscode.ThemeIcon("info", infoColor);
    }
    return new vscode.ThemeIcon("warning", warningColor);
}

function packageVersionText(id: string, version: string | undefined): string {
    const central = ScanState.getCentralVersion(id);
    if (central) {
        return `CPM ${central}`;
    }

    return version || "";
}
