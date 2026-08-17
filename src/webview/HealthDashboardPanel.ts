import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";

/**
 * HealthDashboardPanel
 * PackageHub Health Dashboard (Webview)
 */
export class HealthDashboardPanel {
    public static currentPanel: HealthDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case "refresh":
                        vscode.commands.executeCommand("packageHub.scanWorkspace");
                        break;
                }
            },
            null,
            this._disposables
        );

        this._update();
    }

    public static createOrShow() {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Zaten açıksa sadece öne getir
        if (HealthDashboardPanel.currentPanel) {
            HealthDashboardPanel.currentPanel._panel.reveal(column);
            HealthDashboardPanel.currentPanel._update();
            return;
        }

        // Yeni panel oluştur
        const panel = vscode.window.createWebviewPanel(
            "packageHubDashboard",
            "PackageHub Dashboard",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        HealthDashboardPanel.currentPanel = new HealthDashboardPanel(panel);
    }

    private _update() {
        const vulnerable = ScanState.getVulnerable();
        const outdated = ScanState.getOutDated(); // mevcut ScanState'teki isim

        this._panel.webview.html = this._getHtml(
            vulnerable.length,
            outdated.length
        );
    }

    private _getHtml(vulnerableCount: number, outdatedCount: number): string {
        return /*html*/ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PackageHub Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    h1 {
      font-size: 1.4rem;
      margin-bottom: 20px;
    }
    .cards {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 16px 20px;
      min-width: 140px;
    }
    .card-title {
      font-size: 0.85rem;
      opacity: 0.8;
      margin-bottom: 6px;
    }
    .card-value {
      font-size: 1.6rem;
      font-weight: 600;
    }
    .vulnerable { color: #f14c4c; }
    .outdated { color: #cca700; }
    .healthy { color: #89d185; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <h1>PackageHub Health Dashboard</h1>

  <div class="cards">
    <div class="card">
      <div class="card-title">Vulnerable</div>
      <div class="card-value vulnerable">${vulnerableCount}</div>
    </div>
    <div class="card">
      <div class="card-title">Outdated</div>
      <div class="card-value outdated">${outdatedCount}</div>
    </div>
    <div class="card">
      <div class="card-title">Status</div>
      <div class="card-value ${vulnerableCount + outdatedCount === 0 ? "healthy" : ""}">
        ${vulnerableCount + outdatedCount === 0 ? "Healthy" : "Needs Attention"}
      </div>
    </div>
  </div>

  <button onclick="refresh()">Refresh Scan</button>

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ command: "refresh" });
    }
  </script>
</body>
</html>
    `;
    }

    public dispose() {
        HealthDashboardPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}