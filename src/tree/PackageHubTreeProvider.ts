import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";
import { deprecate } from "node:util";

export class PackageHubTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        description?: string,
        public readonly packageId?: string,
        public readonly latestVersion?: string
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
                    "Actions",
                    vscode.TreeItemCollapsibleState.Expanded
                ),
            ]);
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
                            `${p.version}${p.severity ? " · " + p.severity : ""}`,
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
                            `${p.version} → ${p.latestVersion || "?"}`,
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
                            p.version,
                            p.id,
                            p.latestVersion
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
                new PackageHubTreeItem("Restore All", vscode.TreeItemCollapsibleState.None, {
                    command: "packageHub.restoreAll",
                    title: "Restore All",
                }),
            ]);
        }

        return Promise.resolve([]);
    }
}