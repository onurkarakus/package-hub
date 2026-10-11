import * as fs from "fs/promises";
import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";
import { transitiveCaption } from "../services/TransitiveOrigin";
import { readPackageRef } from "../utils/nugetAudit";
import { deprecate } from "node:util";

export class PackageHubTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        description?: string,
        public readonly packageId?: string,
        public readonly latestVersion?: string,
        public readonly projectPath?: string
    ) {
        super(label, collapsibleState);

        if (description) {
            this.description = description;
        }

        if (packageId) {
            this.contextValue = "packageHub.package";
            this.tooltip = `${packageId}${latestVersion ? " → " + latestVersion : ""}`;
        }
    }
}

export class PackageHubTreeProvider
    implements vscode.TreeDataProvider<PackageHubTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<
        PackageHubTreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PackageHubTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PackageHubTreeItem): Thenable<PackageHubTreeItem[]> {
        const vulnerable = ScanState.getVulnerable();
        const outdated = ScanState.getOutDated();
        const deprecated = ScanState.getDeprecated();
        const conflicts = ScanState.getVersionConflicts();

        if (!element && !ScanState.getScannedAt()) {
            return Promise.resolve([
                new PackageHubTreeItem("Scan Now", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.scanWorkspace",
                    title: "Scan Workspace",
                }),
            ]);
        }

        if (!element) {
            return Promise.resolve([
                new PackageHubTreeItem(
                    "Summary",
                    vscode.TreeItemCollapsibleState.Expanded
                ),
                new PackageHubTreeItem(
                    "Vulnerable",
                    vscode.TreeItemCollapsibleState.Collapsed
                ),
                new PackageHubTreeItem(
                    "Outdated",
                    vscode.TreeItemCollapsibleState.Collapsed
                ),
                new PackageHubTreeItem(
                    "Deprecated",
                    vscode.TreeItemCollapsibleState.Collapsed
                ),
                new PackageHubTreeItem(
                    "Conflicts",
                    vscode.TreeItemCollapsibleState.Collapsed
                ),
                new PackageHubTreeItem(
                    "Projects",
                    vscode.TreeItemCollapsibleState.Collapsed
                ),
                new PackageHubTreeItem(
                    "Actions",
                    vscode.TreeItemCollapsibleState.Expanded
                ),
            ]);
        }

        if (element.projectPath) {
            return packagesForProject(element.projectPath);
        }

        if (element.label === "Projects") {
            return projectNodes();
        }

        if (element.label === "Summary") {
            return Promise.resolve([
                new PackageHubTreeItem(
                    `🔴 Vulnerable (${vulnerable.length})`,
                    vscode.TreeItemCollapsibleState.None
                ),
                new PackageHubTreeItem(
                    `🟠 Outdated (${outdated.length})`,
                    vscode.TreeItemCollapsibleState.None
                ),
                new PackageHubTreeItem(
                    `⚪ Deprecated (${deprecated.length})`,
                    vscode.TreeItemCollapsibleState.None
                ),
                new PackageHubTreeItem(
                    `🔵 Conflicts (${conflicts.length})`,
                    vscode.TreeItemCollapsibleState.None
                ),
            ]);
        }

        if (element.label === "Vulnerable") {
            if (vulnerable.length === 0) {
                return Promise.resolve([
                    new PackageHubTreeItem("No vulnerable packages", vscode.TreeItemCollapsibleState.None),
                ]);
            }

            return Promise.resolve(
                vulnerable.map(
                    (p) =>
                        new PackageHubTreeItem(
                            p.id,
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            `${packageVersionText(p.id, p.version)}${p.severity ? " · " + p.severity : ""}${captionSuffix(p)}`,
                            p.id,
                            p.latestVersion
                        )
                )
            );
        }

        if (element.label === "Outdated") {
            if (outdated.length === 0) {
                return Promise.resolve([
                    new PackageHubTreeItem("No outdated packages", vscode.TreeItemCollapsibleState.None),
                ]);
            }

            return Promise.resolve(
                outdated.map(
                    (p) =>
                        new PackageHubTreeItem(
                            p.id,
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            `${packageVersionText(p.id, p.version)} → ${p.latestVersion || "?"}`,
                            p.id,
                            p.latestVersion
                        )
                )
            );
        }

        if (element.label === "Deprecated") {
            if (deprecated.length === 0) {
                return Promise.resolve([
                    new PackageHubTreeItem(
                        "No deprecated packages",
                        vscode.TreeItemCollapsibleState.None
                    )
                ]);
            }

            return Promise.resolve(
                deprecated.map(
                    (p) =>
                        new PackageHubTreeItem(
                            p.id,
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            packageVersionText(p.id, p.version),
                            p.id,
                            p.latestVersion
                        )
                )
            );
        }

        if (element.label === "Conflicts") {
            if (conflicts.length === 0) {
                return Promise.resolve([
                    new PackageHubTreeItem(
                        "No version conflicts",
                        vscode.TreeItemCollapsibleState.None
                    ),
                ]);
            }

            return Promise.resolve(
                conflicts.map(
                    (c) =>
                        new PackageHubTreeItem(
                            c.id,
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            c.versions.map((v) => v.version).join(" / ")
                        )
                )
            );
        }

        if (element.label === "Actions") {
            return Promise.resolve([
                new PackageHubTreeItem("Scan Now", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.scanWorkspace",
                    title: "Scan Workspace",
                }),
                new PackageHubTreeItem("Open Dashboard", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.showHealthDashboard",
                    title: "Open Dashboard",
                }),
                new PackageHubTreeItem("Copy Health Report", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.copyHealthReport",
                    title: "Copy Health Report",
                }),
                new PackageHubTreeItem("Restore All", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.restoreAll",
                    title: "Restore All",
                }),
            ]);
        }

        return Promise.resolve([]);
    }
}

async function projectNodes(): Promise<PackageHubTreeItem[]> {
    const scanner = new WorkspaceScanner();
    const projects = await scanner.findProjects();
    projects.sort((left, right) =>
        scanner.getProjectName(left).localeCompare(scanner.getProjectName(right))
    );

    if (projects.length === 0) {
        return [
            new PackageHubTreeItem("No projects", vscode.TreeItemCollapsibleState.None),
        ];
    }

    return projects.map(
        (project) =>
            new PackageHubTreeItem(
                scanner.getProjectName(project),
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                undefined,
                undefined,
                undefined,
                project.fsPath
            )
    );
}

async function packagesForProject(projectPath: string): Promise<PackageHubTreeItem[]> {
    let text = "";
    try {
        text = await fs.readFile(projectPath, "utf8");
    } catch {
        return [
            new PackageHubTreeItem("csproj okunamadı.", vscode.TreeItemCollapsibleState.None),
        ];
    }

    const packages = new Map<string, { id: string; version?: string }>();
    for (const line of text.split(/\r?\n/)) {
        const ref = readPackageRef(line);
        if (!ref || ref.kind !== "reference") {
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

    const list = Array.from(packages.values()).sort((left, right) => {
        const rank = packageRank(left.id) - packageRank(right.id);
        return rank || left.id.localeCompare(right.id);
    });

    if (list.length === 0) {
        return [
            new PackageHubTreeItem("No packages", vscode.TreeItemCollapsibleState.None),
        ];
    }

    return list.map((pkg) => projectPackageItem(pkg.id, pkg.version));
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
        return new PackageHubTreeItem(
            id,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            `${shown}${found.vulnerable.severity ? " · " + found.vulnerable.severity : ""}`,
            id,
            found.vulnerable.latestVersion
        );
    }

    if (found.outdated) {
        return new PackageHubTreeItem(
            id,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            `${shown} → ${found.outdated.latestVersion || "?"}`,
            id,
            found.outdated.latestVersion
        );
    }

    if (found.deprecated) {
        return new PackageHubTreeItem(
            id,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            shown,
            id,
            found.deprecated.latestVersion
        );
    }

    return new PackageHubTreeItem(
        id,
        vscode.TreeItemCollapsibleState.None,
        {
            command: "packageHub.showPackageInfo",
            title: "Show Package Info",
            arguments: [{ packageId: id, version }],
        },
        shown,
        id
    );
}

function captionSuffix(pkg: { transitiveOrigins?: { project: string; broughtBy?: string; absentFromGraph: boolean }[] }): string {
    const caption = transitiveCaption(pkg);
    return caption ? ` · ${caption}` : "";
}

function packageVersionText(id: string, version: string | undefined): string {
    const central = ScanState.getCentralVersion(id);
    if (central) {
        return `CPM ${central}`;
    }

    return version || "";
}