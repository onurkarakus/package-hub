import * as vscode from "vscode";
import { formatWhyTree, GraphBuilder } from "../services/GraphBuilder";
import { ScanState } from "../services/ScanState";
import { WorkspaceScanner } from "../services/WorkspaceScanner";

interface WhyText {
    packageId: string;
    text: string;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeJs(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r?\n/g, " ");
}

export class DependencyGraphPanel {

    public static currentPanel: DependencyGraphPanel | undefined;
    private static whyText: WhyText | undefined;
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

                if (message.command === "whyPackage") {
                    vscode.commands.executeCommand("packageHub.whyPackage", {
                        packageId: message.packageId,
                        projectName: message.projectName || undefined,
                    });
                }
            },
            null,
            this._disposables
        );

        this._update();
    }

    public static createOrShow(column?: vscode.ViewColumn) {

        const target = column ?? (vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined);

        if (DependencyGraphPanel.currentPanel) {
            DependencyGraphPanel.currentPanel._panel.reveal(target);
            DependencyGraphPanel.currentPanel._update();

            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "PackageHubGraph",
            "PackageHub Dependency Graph",
            target || vscode.ViewColumn.One,
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

    public static showWhy(packageId: string, text: string) {
        DependencyGraphPanel.whyText = { packageId, text };
        DependencyGraphPanel.createOrShow(vscode.ViewColumn.Beside);
    }

    private async _update() {
        const outdated = ScanState.getOutDated();
        const vulnerable = ScanState.getVulnerable();
        const deprecated = ScanState.getDeprecated();

        const all = [
            ...vulnerable.map((p) => ({ ...p, kind: "vulnerable" })),
            ...outdated.map((p) => ({ ...p, kind: "outdated" })),
            ...deprecated.map((p) => ({ ...p, kind: "deprecated" })),
        ];

        const edgeText = await this.edgeText(all);
        if (DependencyGraphPanel.currentPanel !== this) {
            return;
        }

        this._panel.webview.html = this._getHtml(all, edgeText);
    }

    private async edgeText(packages: any[]): Promise<string> {
        const scanner = new WorkspaceScanner();
        const projects = await scanner.findProjects();
        const severity = new Map<string, string>();

        for (const pkg of packages) {
            if (pkg.severity) {
                severity.set(String(pkg.id).toLowerCase(), String(pkg.severity));
            }
        }

        if (projects.length === 0) {
            return "project.assets.json yok. Kenar uydurulmadı.";
        }

        const blocks: string[] = [];
        for (const project of projects) {
            const graph = await GraphBuilder.fromProject(project.fsPath, severity);
            const ids = packages
                .filter((pkg) => (pkg.projects || []).some(
                    (name: string) => name.toLowerCase() === graph.projectName.toLowerCase()
                ))
                .map((pkg) => String(pkg.id));
            const text = formatWhyTree(graph, ids);
            blocks.push(graph.error ? `${graph.projectName}\n${text}` : text);
        }

        return blocks.join("\n\n");
    }

    private _getHtml(packages: any[], edgeText: string): string {
        const rank: Record<string, number> = {
            vulnerable: 0,
            deprecated: 1,
            outdated: 2,
        };
        const byProject: Record<string, Map<string, any>> = {};

        for (const p of packages) {
            const projects = p.projects?.length ? p.projects : ["Unknown"];
            for (const proj of projects) {
                if (!byProject[proj]) {
                    byProject[proj] = new Map();
                }

                const key = String(p.id || "").toLowerCase();
                const existing = byProject[proj].get(key);
                if (!existing) {
                    byProject[proj].set(key, { ...p });
                    continue;
                }

                if ((rank[p.kind] ?? 9) < (rank[existing.kind] ?? 9)) {
                    existing.kind = p.kind;
                }
                if (!existing.latestVersion && p.latestVersion) {
                    existing.latestVersion = p.latestVersion;
                }
                if (!existing.version && p.version) {
                    existing.version = p.version;
                }
                if (!existing.severity && p.severity) {
                    existing.severity = p.severity;
                }
            }
        }

        const rows = Object.keys(byProject)
            .sort()
            .map((projectName) => {
                const items = Array.from(byProject[projectName].values())
                    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                    .map((p) => {
                        const whyProject = projectName === "Unknown" ? "" : projectName;
                        const current = p.version || "";
                        const latest = p.latestVersion || "";
                        const versionText = latest && latest !== current
                            ? `${current} → ${latest}`
                            : current;
                        const state = p.kind === "vulnerable"
                            ? (p.severity || "Vulnerable")
                            : p.kind === "deprecated"
                                ? "Deprecated"
                                : "Outdated";

                        return `
  <div class="row" onclick="selectPackage('${escapeJs(p.id)}', '${escapeJs(latest)}', '${escapeJs(projectName)}')">
    <span class="name">${escapeHtml(p.id)}</span>
    <span class="ver">${escapeHtml(versionText)}</span>
    <span class="state">${escapeHtml(state)}</span>
    <button type="button" class="why-btn" onclick="event.stopPropagation(); whyPackage('${escapeJs(p.id)}', '${escapeJs(whyProject)}')">Why</button>
  </div>
`;
                    })
                    .join("");

                return `
        <section class="project-block">
          <h2 class="project">${escapeHtml(projectName)}</h2>
          ${items}
        </section>
      `;
            })
            .join("");

        const why = DependencyGraphPanel.whyText;
        const whyBody = why ? escapeHtml(why.text) : "Henüz why çalışmadı.";
        const whyLabel = why ? escapeHtml(why.packageId) : "";

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
    .why {
      margin: 0 0 16px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 8px 10px;
    }
    .why h2 {
      font-size: 12px;
      font-weight: 600;
      margin: 0;
      color: var(--vscode-descriptionForeground);
    }
    .why .meta {
      margin-top: 4px;
      color: var(--vscode-foreground);
    }
    .why pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-editor-foreground);
      background: transparent;
      padding: 0;
      margin: 8px 0 0;
      font-size: 12px;
    }
    .project {
      font-size: 12px;
      font-weight: 600;
      margin: 0 0 4px;
      color: var(--vscode-descriptionForeground);
    }
    .project-block { margin-bottom: 12px; }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 28px;
      padding: 0 8px;
      border-top: 1px solid var(--vscode-widget-border);
      cursor: pointer;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .name { font-weight: 600; }
    .ver, .state {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
    }
    .why-btn {
      margin-left: auto;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: none;
      padding: 2px 0;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .empty { color: var(--vscode-descriptionForeground); }
    .edges { margin: 0 0 16px; }
    .edges h2 {
      font-size: 12px;
      font-weight: 600;
      margin: 0 0 4px;
      color: var(--vscode-descriptionForeground);
    }
    .edges pre {
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
  <h1>Dependency Graph</h1>
  <aside class="why">
    <h2>Why is this here?</h2>
    ${whyLabel ? `<div class="meta">${whyLabel}</div>` : ""}
    <pre>${whyBody}</pre>
  </aside>
  <section class="edges">
    <h2>Edges</h2>
    <pre>${escapeHtml(edgeText)}</pre>
  </section>
  ${rows || "<p class=\"empty\">Önce Scan Workspace çalıştır.</p>"}
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
    function whyPackage(packageId, projectName) {
        vscode.postMessage({
        command: "whyPackage",
        packageId: packageId,
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
            if (d) { d.dispose(); }
        }
    }
}