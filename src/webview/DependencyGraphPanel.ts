import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";

export class DependencyGraphPanel {

    public static currentPanel: DependencyGraphPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (message) => {
                if (message.command === "selectPackage") {
                    vscode.commands.executeCommand("packageHub.updateVulnerable", {
                        packageId: message.packageId,
                        version: message.version,
                        projectName: message.projectName,
                    });
                }
            },
            null,
            this._disposables
        );

        this._update();
    }

    public static createOrShow() {

        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (DependencyGraphPanel.currentPanel) {
            DependencyGraphPanel.currentPanel._panel.reveal(column);
            DependencyGraphPanel.currentPanel._update();

            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "PackageHubGraph",
            "PackageHub Dependency Graph",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        DependencyGraphPanel.currentPanel = new DependencyGraphPanel(panel);
    }

    public static refreshIfOpen() {
        if (DependencyGraphPanel.currentPanel) {
            DependencyGraphPanel.currentPanel._update();
        }
    }

    private _update() {
        const outdated = ScanState.getOutDated();
        const vulnerable = ScanState.getVulnerable();
        const deprecated = ScanState.getDeprecated();

        const all = [
            ...vulnerable.map((p) => ({ ...p, kind: "vulnerable" })),
            ...outdated.map((p) => ({ ...p, kind: "outdated" })),
            ...deprecated.map((p) => ({ ...p, kind: "deprecated" })),
        ];

        this._panel.webview.html = this._getHtml(all);
    }

    private _getHtml(packages: any[]): string {
        const byProject: Record<string, any[]> = {};

        for (const p of packages) {
            const projects = p.projects?.length ? p.projects : ["Unknown"];
            for (const proj of projects) {
                if (!byProject[proj]) {
                    byProject[proj] = [];
                }
                byProject[proj].push(p);
            }
        }

        const columns = Object.keys(byProject)
            .sort()
            .map((projectName) => {
                const items = byProject[projectName]
                    .map((p) => {
                        const color =
                            p.kind === "vulnerable"
                                ? "#f14c4c"
                                : p.kind === "deprecated"
                                    ? "#c586c0"
                                    : "#cca700";

                        return `
  <div class="pkg" style="border-color:${color}" onclick="selectPackage('${p.id}', '${p.latestVersion || ""}', '${projectName}')">
    <strong>${p.id}</strong>
    <div class="meta">${p.version} → ${p.latestVersion || "—"}</div>
  </div>
`;
                    })
                    .join("");

                return `
        <div class="column">
          <div class="project">${projectName}</div>
          <div class="line"></div>
          ${items}
        </div>
      `;
            })
            .join("");

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
      padding: 20px;
      overflow-x: auto;
    }
    h1 { font-size: 1.3rem; }
    .board {
      display: flex;
      gap: 20px;
      align-items: flex-start;
    }
    .column {
        min-width: 260px;
        max-width: 320px;
    }
    .project {
        background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 8px 10px;
      border-radius: 6px;
      font-weight: 600;
    }
    .line {
      width: 2px;
      height: 12px;
      background: var(--vscode-widget-border);
      margin: 0 auto;
    }
    .pkg {
    border: 2px solid;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 8px;
    background: var(--vscode-editorWidget-background);
    overflow-wrap: anywhere;
    word-break: break-word;
    cursor: pointer;
    }

    .pkg strong {
    display: block;
    line-height: 1.3;
    }

    .pkg:hover { filter: brightness(1.15); }

    .meta { opacity: 0.75; font-size: 0.8rem; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>Dependency Graph</h1>
  <p>Her kolon bir proje. Altındaki kutular o projenin problematic paketleri.</p>
  <div class="board">
    ${columns || "<p>Önce Scan Workspace çalıştır.</p>"}
  </div>
  <script>
  const vscode = acquireVsCodeApi();
    function selectPackage(packageId, version, projectName) {
        vscode.postMessage({
        command: "selectPackage",
        packageId: packageId,
        version: version,
        projectName: projectName
  });
}
</script>
</body>
</html>`;
    }

    public dispose() {
        DependencyGraphPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}