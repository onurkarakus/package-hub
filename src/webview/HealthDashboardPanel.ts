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
          case "updatePackage":
            vscode.commands.executeCommand("packageHub.updateVulnerable", {
              packageId: message.packageId,
              version: message.version,
            });
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

  public static refreshIfOpen() {
    if (HealthDashboardPanel.currentPanel) {
      HealthDashboardPanel.currentPanel._update();
    }
  }

  private _update() {
    const vulnerable = ScanState.getVulnerable();
    const outdated = ScanState.getOutDated(); // mevcut ScanState'teki isim

    this._panel.webview.html = this._getHtml(
      vulnerable,
      outdated
    );
  }

  private _getHtml(vulnerable: any[], outdated: any[]): string {
    const vulnerableCount = vulnerable.length;
    const outdatedCount = outdated.length;

    // Tablo satırlarını oluştur
    const createRows = (packages: any[], type: "vulnerable" | "outdated") => {
      if (packages.length === 0) {
        return `<tr><td colspan="5" style="opacity:0.6; padding:12px;">No ${type} packages</td></tr>`;
      }

      return packages
        .map((p) => {
          const latest = p.latestVersion || "";
          const updateButton = latest
            ? `<button class="row-btn" onclick="updatePackage('${p.id}', '${latest}')">Update</button>`
            : "—";

          return `
      <tr>
        <td><strong>${p.id}</strong></td>
        <td>${p.version}</td>
        <td>${latest || "—"}</td>
        <td>${p.projects?.join(", ") || "—"}</td>
        <td>${updateButton}</td>
      </tr>
    `;
        })
        .join("");
    };

    const vulnerableRows = createRows(vulnerable, "vulnerable");
    const outdatedRows = createRows(outdated, "outdated");

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
    h1 { font-size: 1.4rem; margin-bottom: 16px; }
    h2 { font-size: 1.1rem; margin: 24px 0 10px; }
    .cards {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 14px 18px;
      min-width: 130px;
    }
    .card-title { font-size: 0.8rem; opacity: 0.75; margin-bottom: 4px; }
    .card-value { font-size: 1.5rem; font-weight: 600; }
    .vulnerable { color: #f14c4c; }
    .outdated { color: #cca700; }
    .healthy { color: #89d185; }
    .row-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .row-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      margin-bottom: 16px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    th {
      opacity: 0.7;
      font-weight: 500;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      margin-bottom: 16px;
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

  <h2>Vulnerable Packages</h2>
  <table>
    <thead>
      <tr>
        <th>Package</th>
        <th>Version</th>
        <th>Latest</th>
        <th>Projects</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${vulnerableRows}
    </tbody>
  </table>

  <h2>Outdated Packages</h2>
  <table>
    <thead>
      <tr>
        <th>Package</th>
        <th>Version</th>
        <th>Latest</th>
        <th>Projects</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${outdatedRows}
    </tbody>
  </table>

  <script>
      const vscode = acquireVsCodeApi();

      function refresh() {
        vscode.postMessage({ command: "refresh" });
      }

      function updatePackage(packageId, version) {
        vscode.postMessage({
          command: "updatePackage",
          packageId: packageId,
          version: version
        });
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