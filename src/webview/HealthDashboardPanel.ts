import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";

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
          case "setViewMode":
            vscode.workspace
              .getConfiguration("packageHub")
              .update(
                "dashboardViewMode",
                message.mode,
                vscode.ConfigurationTarget.Global
              )
              .then(() => {
                this._update();
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

    if (HealthDashboardPanel.currentPanel) {
      HealthDashboardPanel.currentPanel._panel.reveal(column);
      HealthDashboardPanel.currentPanel._update();
      return;
    }

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
    const outdated = ScanState.getOutDated();
    const deprecated = ScanState.getDeprecated();
    this._panel.webview.html = this._getHtml(vulnerable, outdated, deprecated);
  }

  private _getHtml(vulnerable: any[], outdated: any[], deprecated: any[]): string {

    const ignoredCount = (
      vscode.workspace
        .getConfiguration("packageHub")
        .get<string[]>("ignoredPackages") || []
    ).length;

    const conflicts = ScanState.getVersionConflicts();
    const conflictCount = conflicts.length;

    const vulnerableCount = vulnerable.length;
    const outdatedCount = outdated.length;
    const deprecatedCount = deprecated.length;

    const hasCpm = ScanState.getCpm();

    const scannedAt = ScanState.getScannedAt();
    const scannedText = scannedAt
      ? `Last scanned: ${scannedAt.toLocaleString()}`
      : "Not scanned yet";

    const viewMode =
      vscode.workspace
        .getConfiguration("packageHub")
        .get<string>("dashboardViewMode") || "list";

    const createRows = (
      packages: any[],
      type: "vulnerable" | "outdated" | "deprecated"
    ) => {
      if (packages.length === 0) {
        return `<tr><td colspan="5" style="opacity:0.6; padding:12px;">No ${type} packages</td></tr>`;
      }

      return packages
        .map((p) => {
          const latest = p.latestVersion || "";
          const kind = p.kind || type;

          const badgeClass =
            kind === "vulnerable"
              ? "badge-vuln"
              : kind === "deprecated"
                ? "badge-dep"
                : "badge-out";

          const badgeText =
            kind === "vulnerable"
              ? "Vulnerable"
              : kind === "deprecated"
                ? "Deprecated"
                : "Outdated";

          const updateButton = `<button class="row-btn" onclick="updatePackage('${p.id}', '${latest}')">Update</button>`;

          return `
        <tr>
          <td>
            <strong>${p.id}</strong>
            <span class="badge ${badgeClass}">${badgeText}</span>
          </td>
          <td>${p.version}</td>
          <td>${latest || "—"}</td>
          <td>${p.projects?.join(", ") || "—"}</td>
          <td>${updateButton}</td>
        </tr>
      `;
        })
        .join("");
    };

    const allPackages = [
      ...vulnerable.map((p) => ({ ...p, kind: "vulnerable" })),
      ...outdated.map((p) => ({ ...p, kind: "outdated" })),
      ...deprecated.map((p) => ({ ...p, kind: "deprecated" })),
    ];

    const byProject: Record<string, any[]> = {};
    for (const p of allPackages) {
      const projects =
        p.projects && p.projects.length > 0 ? p.projects : ["Unknown"];
      for (const proj of projects) {
        if (!byProject[proj]) {
          byProject[proj] = [];
        }
        byProject[proj].push(p);
      }
    }

    const byPackage: Record<string, any> = {};
    for (const p of allPackages) {
      const key = p.id.toLowerCase();
      if (!byPackage[key]) {
        byPackage[key] = {
          id: p.id,
          version: p.version,
          latestVersion: p.latestVersion,
          kind: p.kind,
          projects: [...(p.projects || [])],
        };
      } else {
        for (const proj of p.projects || []) {
          if (!byPackage[key].projects.includes(proj)) {
            byPackage[key].projects.push(proj);
          }
        }
      }
    }

    const conflictHtml =
      conflictCount === 0
        ? `<p style="opacity:0.6;">No version conflicts</p>`
        : conflicts
          .map((c) => {

            const pkg = ScanState.getOutDated().find((p) => p.id.toLowerCase() === c.id.toLowerCase()) ||
              ScanState.getDeprecated().find((p) => p.id.toLowerCase() === c.id.toLowerCase()) ||
              ScanState.getVulnerable().find((p) => p.id.toLowerCase() === c.id.toLowerCase());

            const latest = pkg?.latestVersion || "";

            const alignBtn = latest
              ? `<button class="row-btn" onclick="updatePackage('${pkg!.id}', '${latest}')">Align to ${latest}</button>`
              : "";

            const rows = c.versions
              .map(
                (v) => `
            <tr>
              <td>${v.version}</td>
              <td>${v.projects.join(", ")}</td>
            </tr>
          `
              )
              .join("");

            return `
          <details open>
            <summary>
              <strong>${c.id}</strong> (${c.versions.length} farklı versiyon)
                ${alignBtn}
              </summary>
              <table>
                <thead>
                  <tr><th>Version</th><th>Projects</th></tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
          </details>`;
          })
          .join("");

    const listHtml = `
      <details open>
        <summary><strong>Vulnerable Packages</strong> (${vulnerableCount})</summary>
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
          <tbody>${createRows(
      vulnerable.map((p) => ({ ...p, kind: "vulnerable" })),
      "vulnerable"
    )}</tbody>
        </table>
      </details>

      <details open>
        <summary><strong>Outdated Packages</strong> (${outdatedCount})</summary>
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
          <tbody>${createRows(
      outdated.map((p) => ({ ...p, kind: "outdated" })),
      "outdated"
    )}</tbody>
        </table>
      </details>
      <details open>
      <summary><strong>Deprecated Packages</strong> (${deprecatedCount})</summary>
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
          <tbody>${createRows(
      deprecated.map((p) => ({ ...p, kind: "deprecated" })),
      "outdated"
    )}</tbody>
        </table>
      </details>
      <details open>
      <summary><strong>Version Conflicts</strong> (${conflictCount})</summary>
        ${conflictHtml}
      </details>
    `;

    const byProjectHtml = Object.keys(byProject)
      .sort()
      .map((projectName) => {
        const rows = createRows(byProject[projectName], "outdated");
        return `
          <details open>
            <summary><strong>${projectName}</strong> (${byProject[projectName].length})</summary>
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
              <tbody>${rows}</tbody>
            </table>
          </details>
        `;
      })
      .join("");

    const byPackageHtml = Object.values(byPackage)
      .sort((a: any, b: any) => a.id.localeCompare(b.id))
      .map((p: any) => {
        const projectList = (p.projects || [])
          .map((proj: string) => `<li>${proj}</li>`)
          .join("");

        const latest = p.latestVersion || "";
        const updateButton = latest
          ? `<button class="row-btn" onclick="updatePackage('${p.id}', '${latest}')">Update</button>`
          : "";

        return `
          <details open>
            <summary>
              <strong>${p.id}</strong>
              <span class="badge ${p.kind === "vulnerable"
            ? "badge-vuln"
            : p.kind === "deprecated"
              ? "badge-dep"
              : "badge-out"
          }">
                ${p.kind === "vulnerable"
            ? "Vulnerable"
            : p.kind === "deprecated"
              ? "Deprecated"
              : "Outdated"
          }
              </span>
              <span style="opacity:0.7"> ${p.version} → ${latest || "—"}</span>
              ${updateButton}
            </summary>
            <ul>${projectList}</ul>
          </details>
        `;
      })
      .join("");

    const contentHtml =
      viewMode === "byProject"
        ? byProjectHtml || "<p>No packages</p>"
        : viewMode === "byPackage"
          ? byPackageHtml || "<p>No packages</p>"
          : listHtml;

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
    .view-switch { display: flex; gap: 8px; margin-bottom: 16px; }
    .view-switch .active { outline: 2px solid var(--vscode-focusBorder); }
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
    .badge {
      display: inline-block;
      margin-left: 8px;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 0.7rem;
      font-weight: 600;
    }
    .badge-vuln {
      background: #f14c4c;
      color: #fff;
    }
    .badge-out {
      background: #cca700;
      color: #000;
    }
    .badge-dep {
       background: #c586c0;
      color: #fff;
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
    th { opacity: 0.7; font-weight: 500; }
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
    details {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 8px 12px;
    }
    summary {
      cursor: pointer;
      margin-bottom: 8px;
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
      <div class="card-title">Deprecated</div>
    <div class="card-value" style="color:#c586c0;">${deprecatedCount}</div>
    </div>
    <div class="card">
      <div class="card-title">Status</div>
      <div class="card-value ${vulnerableCount + outdatedCount + deprecatedCount === 0 ? "healthy" : ""}">
        ${vulnerableCount + outdatedCount + deprecatedCount === 0 ? "Healthy" : "Needs Attention"}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Conflicts</div>
      <div class="card-value" style="color:#4fc1ff;">${conflictCount}</div>
    </div>
    <div class="card">
      <div class="card-title">CPM</div>
      <div class="card-value ${hasCpm ? "healthy" : ""}">
        ${hasCpm ? "Enabled" : "Not used"}
      </div>
    </div>
  </div>

  <button onclick="refresh()">Refresh Scan</button>

  <div class="view-switch">
    <button class="${viewMode === "list" ? "active" : ""}" onclick="setViewMode('list')">Liste</button>
    <button class="${viewMode === "byProject" ? "active" : ""}" onclick="setViewMode('byProject')">Proje bazlı</button>
    <button class="${viewMode === "byPackage" ? "active" : ""}" onclick="setViewMode('byPackage')">Paket bazlı</button>
  </div>

  ${contentHtml}

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

    function setViewMode(mode) {
      vscode.postMessage({ command: "setViewMode", mode: mode });
    }
  </script>
  <footer style="margin-top: 24px; opacity: 0.7; font-size: 0.85rem;">
     <p style="opacity:0.7; font-size:0.85rem;">
      Ignored: ${ignoredCount}
      ${ignoredCount > 0 ? "(PackageHub: Unignore Package ile geri al)" : ""}
    </p>
    ${scannedText}
  </footer>
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