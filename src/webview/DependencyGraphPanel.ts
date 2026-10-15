import * as vscode from "vscode";
import { formatNodePath, GraphBuilder, PackageGraph } from "../services/GraphBuilder";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export class DependencyGraphPanel {

    public static currentPanel: DependencyGraphPanel | undefined;
    private packageId: string;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, packageId: string) {
        this._panel = panel;
        this.packageId = packageId;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        void this._update();
    }

    public static async show(packageId: string): Promise<void> {
        const id = packageId.trim();
        if (!id) {
            return;
        }

        const target = vscode.ViewColumn.Beside;

        if (DependencyGraphPanel.currentPanel) {
            DependencyGraphPanel.currentPanel.packageId = id;
            DependencyGraphPanel.currentPanel._panel.title = id;
            DependencyGraphPanel.currentPanel._panel.reveal(target);
            await DependencyGraphPanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "PackageHubGraph",
            id,
            target,
            {
                enableScripts: false,
                retainContextWhenHidden: true,
            }
        );

        DependencyGraphPanel.currentPanel = new DependencyGraphPanel(panel, id);
    }

    public static refreshIfOpen() {
        if (DependencyGraphPanel.currentPanel) {
            void DependencyGraphPanel.currentPanel._update();
        }
    }

    private async _update() {
        const packageId = this.packageId;
        this._panel.title = packageId;
        this._panel.webview.html = this._getHtml(packageId, "Reading the path.");

        const text = await this.loadPath(packageId);
        if (DependencyGraphPanel.currentPanel !== this || this.packageId !== packageId) {
            return;
        }

        this._panel.webview.html = this._getHtml(packageId, text);
    }

    private async loadPath(packageId: string): Promise<string> {
        const scanner = new WorkspaceScanner();
        const projects = await scanner.findProjects();
        projects.sort((left, right) =>
            scanner.getProjectName(left).localeCompare(scanner.getProjectName(right))
        );

        const severity = new Map<string, string>();
        for (const pkg of [
            ...ScanState.getVulnerable(),
            ...ScanState.getOutDated(),
            ...ScanState.getDeprecated(),
        ]) {
            if (pkg.severity) {
                severity.set(pkg.id.toLowerCase(), pkg.severity);
            }
        }

        const graphs: PackageGraph[] = [];
        for (const project of projects) {
            graphs.push(await GraphBuilder.fromProject(project.fsPath, severity));
        }

        return formatNodePath(graphs, packageId);
    }

    private _getHtml(packageId: string, pathText: string): string {
        return /*html*/ `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 20px;
      font-size: 13px;
    }
    h1 {
      font-size: 13px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-editor-foreground);
      background: transparent;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 8px 10px;
      margin: 0;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(packageId)}</h1>
  <pre>${escapeHtml(pathText)}</pre>
</body>
</html>`;
    }

    public dispose() {
        DependencyGraphPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
