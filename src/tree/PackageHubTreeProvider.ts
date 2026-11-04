import * as fs from "fs/promises";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { directProjectNames, formatProjectRelations, transitiveCaption } from "../services/TransitiveOrigin";
import { getFeedHealth } from "../services/FeedHealth";
import { readPackageRefs, severityRank as severityLevel } from "../utils/nugetAudit";

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
};

export class PackageHubTreeItem extends vscode.TreeItem {
    public readonly packageId?: string;
    public readonly latestVersion?: string;
    public readonly projectPath?: string;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        options?: ItemOptions
    ) {
        super(label, collapsibleState);
        this.packageId = options?.packageId;
        this.latestVersion = options?.latestVersion;
        this.projectPath = options?.projectPath;

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
            this.contextValue = "packageHub.package";
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

        if (!element && !ScanState.getScannedAt()) {
            return [
                new PackageHubTreeItem("Scan Now", vscode.TreeItemCollapsibleState.None, {
                    command: {
                        command: "packageHub.scanWorkspace",
                        title: "Scan Workspace",
                    },
                    description: "Not scanned",
                    icon: new vscode.ThemeIcon("search"),
                }),
            ];
        }

        if (!element) {
            const projects = await sharedScanner.findProjects();
            const feeds = getFeedHealth();
            const failingFeeds = feeds.statuses.filter((status) => status.enabled && status.failures.length > 0).length
                + (feeds.unmatched.length > 0 ? 1 : 0);
            const expandProjects = projects.length > 0 && projects.length <= 4 && vulnerable.length > 0;
            return [
                section("Vulnerable", vulnerable.length, vulnerable.length > 0, new vscode.ThemeIcon("error", errorColor)),
                section("Outdated", outdated.length, vulnerable.length === 0 && outdated.length > 0, new vscode.ThemeIcon("arrow-circle-up", warningColor)),
                section("Deprecated", deprecated.length, false, new vscode.ThemeIcon("archive", warningColor)),
                section("Conflicts", conflicts.length, false, new vscode.ThemeIcon("diff", warningColor)),
                section(
                    "Projects",
                    projects.length,
                    expandProjects,
                    new vscode.ThemeIcon("project"),
                    projects.length > 0
                ),
                new PackageHubTreeItem("Feeds", vscode.TreeItemCollapsibleState.Collapsed, {
                    description: feeds.sources
                        ? `${feeds.sources.filter((source) => source.enabled).length} enabled${failingFeeds > 0 ? ` · ${failingFeeds} failed` : ""}`
                        : "Not read",
                    icon: failingFeeds > 0
                        ? new vscode.ThemeIcon("warning", warningColor)
                        : new vscode.ThemeIcon("cloud"),
                    tooltip: "Package sources dotnet uses, and failures from the last scan or restore.",
                }),
                new PackageHubTreeItem("Actions", vscode.TreeItemCollapsibleState.Collapsed, {
                    icon: new vscode.ThemeIcon("tools"),
                }),
            ];
        }

        if (element.projectPath) {
            return packagesForProject(element.projectPath);
        }

        if (element.label === "Projects") {
            return projectNodes();
        }

        if (element.label === "Vulnerable") {
            if (vulnerable.length === 0) {
                return [emptyItem("No vulnerable packages")];
            }

            return [...vulnerable]
                .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.id.localeCompare(right.id))
                .map((pkg) => packageItem(pkg.id, vulnerableDescription(pkg), severityIcon(pkg.severity), pkg.latestVersion));
        }

        if (element.label === "Outdated") {
            if (outdated.length === 0) {
                return [emptyItem("No outdated packages")];
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

        if (element.label === "Deprecated") {
            if (deprecated.length === 0) {
                return [emptyItem("No deprecated packages")];
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

        if (element.label === "Conflicts") {
            if (conflicts.length === 0) {
                return [emptyItem("No version conflicts")];
            }

            return conflicts.map(
                (conflict) => packageItem(
                    conflict.id,
                    conflict.versions.map((version) => version.version).join(" / "),
                    new vscode.ThemeIcon("diff", warningColor)
                )
            );
        }

        if (element.label === "Feeds") {
            return feedNodes();
        }

        if (element.label === "Actions") {
            return [
                action("Scan Now", "packageHub.scanWorkspace", "search"),
                action("Open Dashboard", "packageHub.showHealthDashboard", "dashboard"),
                action("Copy Health Report", "packageHub.copyHealthReport", "notebook"),
                action("Copy Vulnerability Report", "packageHub.copyVulnerabilityReport", "shield"),
                action("Restore All", "packageHub.restoreAll", "cloud-download"),
            ];
        }

        return [];
    }

    private updateBadge(): void {
        if (!this.view) {
            return;
        }

        const count = ScanState.getScannedAt() ? ScanState.getVulnerable().length : 0;
        this.view.badge = count > 0
            ? { value: count, tooltip: `${count} vulnerable` }
            : undefined;
    }
}

function section(
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
    latestVersion?: string
): PackageHubTreeItem {
    const found = ScanState.findPackage(id);
    const latest = latestVersion || found.outdated?.latestVersion || found.vulnerable?.latestVersion;
    return new PackageHubTreeItem(id, vscode.TreeItemCollapsibleState.None, {
        command: {
            command: "packageHub.revealPackage",
            title: "Open Package",
            arguments: [{ packageId: id }],
        },
        description,
        packageId: id,
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
            new PackageHubTreeItem("No projects", vscode.TreeItemCollapsibleState.None, {
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
            description: rows ? projectHealthText(rows) : "Could not read the csproj.",
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
            new PackageHubTreeItem("Could not read the csproj.", vscode.TreeItemCollapsibleState.None, {
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
            new PackageHubTreeItem("No packages", vscode.TreeItemCollapsibleState.None, {
                icon: new vscode.ThemeIcon("info", infoColor),
                tooltip: "No PackageReference in this file.",
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
        return "No packages";
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
        parts.push(`${vulnerable} vulnerable`);
    }
    if (outdated > 0) {
        parts.push(`${outdated} outdated`);
    }
    if (deprecated > 0) {
        parts.push(`${deprecated} deprecated`);
    }
    if (parts.length === 0) {
        return rows.length === 1 ? "1 package" : `${rows.length} packages`;
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
            tooltip.appendText(`Highest patch ${info.highestPatch}`);
        }
        if (info.latestVersion && info.latestVersion !== info.highestPatch) {
            tooltip.appendMarkdown("\n\n");
            tooltip.appendText(`Latest ${info.latestVersion}`);
        }
    }

    const advisory = found.vulnerable?.advisoryUrl;
    if (advisory && advisory.startsWith("https://") && !advisory.includes(" ")) {
        tooltip.appendMarkdown(`\n\n[Advisory](${advisory})`);
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
            state.sourceError ? "dotnet did not list the sources" : "Scan to read the sources",
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
            description: !status.enabled ? "disabled" : failed ? `failed (${status.failures[0].code})` : "enabled",
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
        items.push(emptyItem("No package sources"));
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
