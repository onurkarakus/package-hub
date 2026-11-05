import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { advisoryCatalogSource, advisoryVerdict, firstFixedVersion } from "../services/AdvisoryCatalog";
import { getFeedHealth } from "../services/FeedHealth";
import { ScanState } from "../services/ScanState";
import { onlineLookupsEnabled } from "../services/Settings";
import { isValidPackageId, isValidPackageVersion } from "../utils/nugetAudit";
import { buildDashboardState, DashboardState, findAction } from "./DashboardState";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function makeNonce(): string {
  return randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

export type DashboardMessage =
  | { command: "ready" }
  | { command: "refresh" }
  | { command: "updatePackage"; packageId: string; version?: string }
  | { command: "applyAction"; actionId: string }
  | { command: "previewAction"; actionId: string }
  | { command: "showDependencies"; packageId: string }
  | { command: "openAdvisory"; url: string };

/** What the extension sends to the page. */
export type DashboardHostMessage =
  | { type: "state"; state: DashboardState }
  | { type: "loading" };

const ACTION_ID = /^(patch|minor|(update|pin|replace):[A-Za-z0-9_.-]{1,100})$/;

export function isActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID.test(value);
}

export function isAdvisoryUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("https://")) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks a message from the webview. Anything with an unknown command or a
 * field of the wrong shape is dropped.
 */
export function readDashboardMessage(message: unknown): DashboardMessage | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const value = message as Record<string, unknown>;
  switch (value.command) {
    case "ready":
      return { command: "ready" };
    case "refresh":
      return { command: "refresh" };
    case "updatePackage":
      if (!isValidPackageId(value.packageId)) {
        return undefined;
      }
      if (value.version !== undefined && value.version !== "" && !isValidPackageVersion(value.version)) {
        return undefined;
      }
      return {
        command: "updatePackage",
        packageId: value.packageId,
        version: typeof value.version === "string" && value.version ? value.version : undefined,
      };
    case "applyAction":
    case "previewAction":
      return isActionId(value.actionId) ? { command: value.command, actionId: value.actionId } : undefined;
    case "showDependencies":
      return isValidPackageId(value.packageId) ? { command: "showDependencies", packageId: value.packageId } : undefined;
    case "openAdvisory":
      return isAdvisoryUrl(value.url) ? { command: "openAdvisory", url: value.url } : undefined;
    default:
      return undefined;
  }
}

export interface DashboardPage {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

const ICONS: Record<string, string> = {
  shield: '<path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 6 5.5 7 3.2-1 5.5-3.7 5.5-7v-4L8 1.5Z"/><path d="M8 5v3.2M8 10.6v.1"/>',
  up: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  archive: '<rect x="1.8" y="2.5" width="12.4" height="3.2" rx="1"/><path d="M3 5.7v6.8c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V5.7M6.3 8.5h3.4"/>',
  feed: '<path d="M3 9a4 4 0 0 1 4 4M3 5a8 8 0 0 1 8 8"/><circle cx="3.4" cy="12.6" r="1"/>',
  info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2V11M8 5v.1"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.6 3.6"/>',
  chev: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  arrow: '<path d="M2.5 8h11M9.5 4l4 4-4 4"/>',
  refresh: '<path d="M13.3 8A5.3 5.3 0 1 1 11.7 4.2M13.3 2.5v3h-3"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  proj: '<path d="M2.5 4.5c0-.6.4-1 1-1h3l1.5 1.5h4.5c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1v-7.5Z"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4V1.8Z"/><path d="M9 1.8v3h3"/>',
  bolt: '<path d="M9 1.5 3.5 9h4l-1 5.5L12.5 7h-4l.5-5.5Z"/>',
  ext: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5c0 .3-.2.5-.5.5H3c-.3 0-.5-.2-.5-.5V5c0-.3.2-.5.5-.5h3.5"/>',
  graph: '<circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M5.2 5.2 7 10.6M10.8 5.2 9 10.6"/>',
  warn: '<path d="M8 2 1.8 13h12.4L8 2Z"/><path d="M8 6.5v3M8 11.3v.1"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
};

function iconDefs(): string {
  return Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${body}</symbol>`)
    .join("");
}

function icon(name: string, extra = ""): string {
  return `<svg class="i ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/**
 * The page shell. The data comes later through postMessage, so nothing from
 * the scan is written into this HTML.
 */
export function dashboardHtml(page: DashboardPage): string {
  const nonce = escapeHtml(page.nonce);
  const csp = [
    "default-src 'none'",
    `style-src ${page.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${page.cspSource}`,
    `font-src ${page.cspSource}`,
  ].join("; ");
  const sortHead = (key: string, label: string) =>
    `<th data-sort="${key}"><button type="button">${label}${icon("down", "sm sort-ind")}</button></th>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeHtml(page.styleUri)}">
  <title>PackageHub Dashboard</title>
</head>
<body class="is-loading">
  <svg width="0" height="0" class="defs" aria-hidden="true"><defs>${iconDefs()}</defs></svg>
  <div class="app">
    <header class="card header">
      <div class="ring live" id="ring" role="img" aria-label="Health score">
        <svg viewBox="0 0 84 84" aria-hidden="true">
          <circle class="track" cx="42" cy="42" r="36" fill="none" stroke-width="8"/>
          <circle class="value" id="ring-value" cx="42" cy="42" r="36" fill="none" stroke-width="8"/>
        </svg>
        <div class="ring-label"><strong id="score">–</strong><span>/ 100</span></div>
      </div>
      <span class="sk skel-ring skel"></span>
      <div class="title-block">
        <h1>Workspace health
          <span class="verdict live" id="verdict"></span>
          <span class="info live" id="formula-info">
            <button class="info-btn" type="button" aria-describedby="formula-tip" aria-label="How the score is calculated">${icon("info")}</button>
            <span class="tooltip" role="tooltip" id="formula-tip"></span>
          </span>
        </h1>
        <div class="sub live" id="sub"></div>
        <div class="breakdown live" id="breakdown"></div>
        <div class="skel skel-lines"><span class="sk w40"></span><span class="sk w60 h18"></span></div>
      </div>
      <div class="header-actions">
        <div class="scan-meta" id="scan-meta"></div>
        <div class="btn-row">
          <button class="btn secondary" type="button" data-action="showFeeds">${icon("feed", "sm")}Feeds</button>
          <button class="btn" type="button" data-action="refresh">${icon("refresh", "sm")}Rescan</button>
        </div>
      </div>
    </header>

    <div class="notices" id="notices"></div>

    <section class="kpis" id="kpis" aria-label="Summary"></section>

    <div class="main">
      <section class="card panel" aria-label="Packages">
        <div class="panel-head">
          <h2>Packages <span class="count live" id="row-count"></span></h2>
          <span class="filter-pill" id="filter-pill"><span id="filter-pill-text"></span><button type="button" data-action="clearFilter" aria-label="Clear filter">${icon("x", "sm")}</button></span>
          <span class="spacer"></span>
          <span class="sort-label live" id="sort-label"></span>
          <div class="seg" role="group" aria-label="Dependency type" id="kind-seg">
            <button type="button" data-kind="all" class="is-on">All</button>
            <button type="button" data-kind="direct">Direct</button>
            <button type="button" data-kind="transitive">Transitive</button>
          </div>
          <label class="search">${icon("search", "sm")}<input id="search" type="search" placeholder="Search packages, advisories, projects" aria-label="Search packages"></label>
        </div>
        <div class="progress skel"></div>
        <div class="progress live-progress"></div>
        <div class="table-wrap live">
          <table class="pk">
            <colgroup><col class="c-chev"><col class="c-pkg"><col class="c-cur"><col class="c-sug"><col class="c-chg"><col class="c-sev"><col class="c-prj"><col class="c-kind"></colgroup>
            <thead><tr>
              <th></th>
              ${sortHead("name", "Package")}
              ${sortHead("current", "Current")}
              <th>Suggested</th>
              ${sortHead("change", "Change")}
              ${sortHead("severity", "Severity")}
              ${sortHead("projects", "Projects")}
              ${sortHead("kind", "Type")}
            </tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
        <div class="skel" id="skel-rows"></div>
      </section>

      <aside class="card panel" aria-label="Recommended actions">
        <div class="panel-head">
          <div class="tabs" role="tablist">
            <button type="button" role="tab" data-tab="actions" class="is-on">${icon("bolt")}Recommended actions <span class="count live" id="act-count"></span></button>
            <button type="button" role="tab" data-tab="feeds">${icon("feed")}Feeds <span class="count live" id="feed-count"></span></button>
          </div>
        </div>
        <div class="actions-body live" id="actions"></div>
        <div class="actions-body live is-hidden" id="feeds"></div>
        <div class="actions-body skel" id="skel-actions"></div>
        <div class="actions-foot live">${icon("lock", "sm")}<span id="actions-foot"></span></div>
      </aside>
    </div>

    <section class="card heat" id="heat" aria-label="Projects"></section>
  </div>
  <script nonce="${nonce}" src="${escapeHtml(page.scriptUri)}"></script>
</body>
</html>`;
}

function ignoredCount(): number {
  return (vscode.workspace.getConfiguration("packageHub").get<string[]>("ignoredPackages") || []).length;
}

async function centralFiles(): Promise<string[]> {
  if (!ScanState.getCpm()) {
    return [];
  }
  try {
    const found = await vscode.workspace.findFiles("**/Directory.Packages.props", "**/{bin,obj,node_modules}/**", 10);
    return found.map((uri) => vscode.workspace.asRelativePath(uri)).sort();
  } catch {
    return [];
  }
}

export async function currentDashboardState(): Promise<DashboardState> {
  return buildDashboardState({
    vulnerable: ScanState.getVulnerable(),
    outdated: ScanState.getOutDated(),
    deprecated: ScanState.getDeprecated(),
    installed: ScanState.getInstalled(),
    scannedAt: ScanState.getScannedAt(),
    cpm: ScanState.getCpm(),
    centralFiles: await centralFiles(),
    feeds: getFeedHealth(),
    online: onlineLookupsEnabled(),
    advisorySource: advisoryCatalogSource(),
    conflicts: ScanState.getVersionConflicts().length,
    ignored: ignoredCount(),
    auditDataGap: ScanState.hasAuditDataGap(),
    unreadableProjects: ScanState.getUnreadableProjects(),
    verdict: (packageId, url, version) => advisoryVerdict(packageId, url, version),
    firstFixed: (packageId, url, current) => firstFixedVersion(packageId, url, current),
    relativePath: (filePath) => vscode.workspace.asRelativePath(filePath),
  });
}

export class HealthDashboardPanel {
  public static currentPanel: HealthDashboardPanel | undefined;
  private static scanning = false;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _state: DashboardState | undefined;
  private _ready = false;
  private _version = 0;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw), null, this._disposables);

    const webview = this._panel.webview;
    const media = vscode.Uri.joinPath(extensionUri, "media");
    webview.html = dashboardHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, "dashboard.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, "dashboard.css")).toString(),
    });
  }

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (HealthDashboardPanel.currentPanel) {
      HealthDashboardPanel.currentPanel._panel.reveal(column);
      void HealthDashboardPanel.currentPanel._update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "packageHubDashboard",
      "PackageHub Dashboard",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    HealthDashboardPanel.currentPanel = new HealthDashboardPanel(panel, extensionUri);
  }

  public static refreshIfOpen() {
    if (HealthDashboardPanel.currentPanel) {
      void HealthDashboardPanel.currentPanel._update();
    }
  }

  /** Shows the loading state while a scan runs. */
  public static setScanning(scanning: boolean) {
    HealthDashboardPanel.scanning = scanning;
    const current = HealthDashboardPanel.currentPanel;
    if (current && scanning && current._ready) {
      void current._panel.webview.postMessage({ type: "loading" } satisfies DashboardHostMessage);
    }
  }

  private onMessage(raw: unknown) {
    const message = readDashboardMessage(raw);
    if (!message) {
      return;
    }
    switch (message.command) {
      case "ready":
        this._ready = true;
        void this._update();
        break;
      case "refresh":
        void vscode.commands.executeCommand("packageHub.scanWorkspace");
        break;
      case "updatePackage":
        void vscode.commands.executeCommand("packageHub.updateVulnerable", {
          packageId: message.packageId,
          version: message.version,
        });
        break;
      case "showDependencies":
        void vscode.commands.executeCommand("packageHub.showDependencyGraph", { packageId: message.packageId });
        break;
      case "openAdvisory":
        void vscode.commands.executeCommand("packageHub.openAdvisory", message.url);
        break;
      case "applyAction":
        void this.applyAction(message.actionId);
        break;
      case "previewAction":
        void this.previewAction(message.actionId);
        break;
    }
  }

  private async applyAction(actionId: string) {
    const action = findAction(this._state, actionId);
    if (!action) {
      return;
    }
    switch (action.kind) {
      case "patch":
        await vscode.commands.executeCommand("packageHub.updateHighestPatch");
        break;
      case "minor":
        await vscode.commands.executeCommand("packageHub.updateHighestMinor");
        break;
      case "update":
      case "pin": {
        const update = action.updates[0];
        if (update && isValidPackageId(update.packageId) && isValidPackageVersion(update.to)) {
          await vscode.commands.executeCommand("packageHub.updateVulnerable", {
            packageId: update.packageId,
            version: update.to,
          });
        }
        break;
      }
      case "replace": {
        const update = action.updates[0];
        if (update && isValidPackageId(update.packageId)) {
          await vscode.commands.executeCommand("packageHub.showDependencyGraph", { packageId: update.packageId });
        }
        break;
      }
    }
  }

  private async previewAction(actionId: string) {
    const action = findAction(this._state, actionId);
    if (!action) {
      return;
    }
    const canApply = action.kind !== "replace";
    const choice = await vscode.window.showInformationMessage(
      action.preview.heading,
      { modal: true, detail: action.preview.lines.join("\n") },
      ...(canApply ? [action.button] : [])
    );
    if (canApply && choice === action.button) {
      await this.applyAction(actionId);
    }
  }

  private async _update() {
    if (!this._ready) {
      return;
    }
    const version = ++this._version;
    if (HealthDashboardPanel.scanning && !ScanState.getScannedAt()) {
      await this._panel.webview.postMessage({ type: "loading" } satisfies DashboardHostMessage);
      return;
    }
    const state = await currentDashboardState();
    if (version !== this._version) {
      return;
    }
    this._state = state;
    await this._panel.webview.postMessage({ type: "state", state } satisfies DashboardHostMessage);
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
