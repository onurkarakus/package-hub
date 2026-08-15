import * as vscode from "vscode";

export class PackageHubTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
    }
}

export class PackageHubTreeProvider implements vscode.TreeDataProvider<PackageHubTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PackageHubTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private vulnerableCount = 0;
    private outdatedCount = 0;

    refresh(vulnerable: number, outdated: number): void {
        this.vulnerableCount = vulnerable;
        this.outdatedCount = outdated;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PackageHubTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PackageHubTreeItem): Thenable<PackageHubTreeItem[]> {
        if (!element) {
            // Root seviye
            return Promise.resolve([
                new PackageHubTreeItem("Summary", vscode.TreeItemCollapsibleState.Expanded),
                new PackageHubTreeItem("Actions", vscode.TreeItemCollapsibleState.Expanded),
            ]);
        }

        if (element.label === "Summary") {
            return Promise.resolve([
                new PackageHubTreeItem(
                    `🔴 Vulnerable (${this.vulnerableCount})`,
                    vscode.TreeItemCollapsibleState.None
                ),
                new PackageHubTreeItem(
                    `🟠 Outdated (${this.outdatedCount})`,
                    vscode.TreeItemCollapsibleState.None
                ),
                new PackageHubTreeItem(
                    `🟢 Healthy`,
                    vscode.TreeItemCollapsibleState.None
                ),
            ]);
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
            ]);
        }

        return Promise.resolve([]);
    }
}