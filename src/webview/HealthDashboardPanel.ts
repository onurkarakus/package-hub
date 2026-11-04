import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { advisoryCatalogSource } from "../services/AdvisoryCatalog";
import { FeedHealthState, getFeedHealth } from "../services/FeedHealth";
import { ScanState } from "../services/ScanState";
import { dashboardViewMode, isDashboardViewMode, onlineLookupsEnabled } from "../services/Settings";
import { formatProjectRelations, projectRelationCaption } from "../services/TransitiveOrigin";
import { isValidPackageId, isValidPackageVersion } from "../utils/nugetAudit";

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
  | { command: "refresh" }
  | { command: "updatePackage"; packageId: string; version?: string }
  | { command: "safeUpdate"; channel: "patch" | "minor" }
  | { command: "filter"; query?: string; severity?: string }
  | { command: "setViewMode"; mode: "list" | "byProject" | "byPackage"; query?: string; severity?: string }
  | { command: "showDependencies"; packageId: string };

/**
 * Checks a message from the webview. Anything with an unknown command or a
 * field of the wrong shape is dropped.
 */
export function readDashboardMessage(message: unknown): DashboardMessage | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const value = message as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.length <= 200 ? field : undefined);
  switch (value.command) {
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
    case "safeUpdate":
      return value.channel === "patch" || value.channel === "minor"
        ? { command: "safeUpdate", channel: value.channel }
        : undefined;
    case "filter":
      return { command: "filter", query: text(value.query), severity: text(value.severity) };
    case "setViewMode":
      return isDashboardViewMode(value.mode)
        ? { command: "setViewMode", mode: value.mode, query: text(value.query), severity: text(value.severity) }
        : undefined;
    case "showDependencies":
      return isValidPackageId(value.packageId) ? { command: "showDependencies", packageId: value.packageId } : undefined;
    default:
      return undefined;
  }
}

export function feedHealthHtml(state: FeedHealthState, online: boolean): string {
  const rows = state.statuses.map((status) => {
    const failed = status.failures.length > 0;
    const stateText = !status.enabled ? "Disabled" : failed ? "Failed in the last scan" : "No failure seen";
    const failures = status.failures
      .map((failure) => `<li><code>${escapeHtml(failure.code)}</code> ${escapeHtml(failure.message)}</li>`)
      .join("");
    const hints = status.hints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join("");
    return `
      <tr class="${failed ? "feed-failed" : ""}">
        <td><strong>${escapeHtml(status.name)}</strong><div class="muted">${escapeHtml(status.url)}</div></td>
        <td>${escapeHtml(stateText)}</td>
        <td>${failures ? `<ul>${failures}</ul>` : "—"}${hints ? `<ul class="hints">${hints}</ul>` : ""}</td>
      </tr>`;
  }).join("");
  const unmatched = state.unmatched.length > 0
    ? `<p>Other feed messages:</p><ul>${state.unmatched
      .map((failure) => `<li><code>${escapeHtml(failure.code)}</code> ${escapeHtml(failure.message)}</li>`)
      .join("")}</ul>`
    : "";
  const providers = state.credentialProviders.length > 0
    ? `<p class="muted">Credential providers found: ${escapeHtml(state.credentialProviders.join(", "))}</p>`
    : "";
  const source = state.sources === undefined
    ? `<p class="muted">dotnet did not list the sources${state.sourceError ? `: ${escapeHtml(state.sourceError)}` : "."}</p>`
    : state.sources.length === 0 ? `<p class="muted">dotnet lists no package sources.</p>` : "";
  const table = rows
    ? `<table><thead><tr><th>Source</th><th>State</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";
  const privacy = online
    ? "packageHub.onlineLookups is on: PackageHub may read advisory and publish data from nuget.org."
    : "PackageHub made no network request of its own. Feed data comes from dotnet and local files.";
  return `${source}${table}${unmatched}${providers}<p class="muted">${escapeHtml(privacy)}</p>`;
}

function graphOnlyWarning(pkg: {
  isTransitive?: boolean;
  transitiveOrigins?: { absentFromGraph: boolean }[];
}): boolean {
  const origins = pkg.transitiveOrigins || [];
  return pkg.isTransitive === true
    && origins.length > 0
    && origins.every((origin) => origin.absentFromGraph);
}

function packageNameButton(id: string): string {
  return `<button type="button" class="pkg-link" data-action="showDependencies" data-package="${escapeHtml(id)}">${escapeHtml(id)}</button>`;
}

function updateButton(id: string, version: string, label: string): string {
  return `<button type="button" class="row-btn" data-action="updatePackage" data-package="${escapeHtml(id)}" data-version="${escapeHtml(version)}">${escapeHtml(label)}</button>`;
}

function normalizeSeverity(value: unknown): string {
  const text = typeof value === "string" ? value.toLowerCase() : "all";
  return ["all", "critical", "high", "moderate", "low"].includes(text) ? text : "all";
}

export class HealthDashboardPanel {
  public static currentPanel: HealthDashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private query = "";
  private severity = "all";

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (raw) => {
        const message = readDashboardMessage(raw);
        if (!message) {
          return;
        }
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
          case "safeUpdate":
            if (message.channel === "patch") {
              vscode.commands.executeCommand("packageHub.updateHighestPatch");
            } else if (message.channel === "minor") {
              vscode.commands.executeCommand("packageHub.updateHighestMinor");
            }
            break;
          case "filter":
            this.rememberFilter(message);
            break;
          case "setViewMode":
            this.rememberFilter(message);
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
          case "showDependencies":
            vscode.commands.executeCommand("packageHub.showDependencyGraph", {
              packageId: message.packageId,
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
        localResourceRoots: [],
      }
    );

    HealthDashboardPanel.currentPanel = new HealthDashboardPanel(panel);
  }

  public static refreshIfOpen() {
    if (HealthDashboardPanel.currentPanel) {
      HealthDashboardPanel.currentPanel._update();
    }
  }

  private rememberFilter(message: { query?: unknown; severity?: unknown }) {
    if (typeof message.query === "string") {
      this.query = message.query;
    }
    if (typeof message.severity === "string") {
      this.severity = normalizeSeverity(message.severity);
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
    const scannedText = scannedAt ? `Last scanned ${scannedAt.toLocaleString()}` : "";
    const nonce = makeNonce();
    const cspSource = this._panel.webview.cspSource;
    const feedHtml = feedHealthHtml(getFeedHealth(), onlineLookupsEnabled());
    const advisorySource = advisoryCatalogSource();
    const advisoryText = advisorySource === "local"
      ? "Advisory ranges: local NuGet audit cache."
      : advisorySource === "online"
        ? "Advisory ranges: nuget.org (packageHub.onlineLookups is on)."
        : "Advisory ranges: not loaded. Restore once with NuGetAudit on, or turn on packageHub.onlineLookups.";
    const sources = ScanState.getPackageSources();
    const auditDataGap = ScanState.hasAuditDataGap();
    const sourcesText = !sources
      ? ""
      : sources.unreadable
        ? "Could not read NuGet.config."
        : !sources.found
          ? "No NuGet.config."
          : sources.names.length === 0
            ? "No sources."
            : `Sources: ${sources.names.join(", ")}`;

    const viewMode = dashboardViewMode();
    const query = this.query;
    const severity = this.severity;
    const severityById = new Map<string, string>();
    for (const pkg of [...vulnerable, ...outdated, ...deprecated]) {
      if (pkg.severity && !severityById.has(String(pkg.id).toLowerCase())) {
        severityById.set(String(pkg.id).toLowerCase(), String(pkg.severity));
      }
    }
    const packageSeverity = (pkg: { id?: string; severity?: string }) =>
      String(pkg.severity || severityById.get(String(pkg.id || "").toLowerCase()) || "").toLowerCase();

    const createRows = (
      packages: any[],
      type: "vulnerable" | "outdated" | "deprecated",
      projectName?: string,
      showProjects = true
    ) => {
      const columns = showProjects ? 5 : 4;
      if (packages.length === 0) {
        return `<tr><td colspan="${columns}" class="empty">No ${escapeHtml(type)} packages</td></tr>`;
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

          const rowButton = latest && !graphOnlyWarning(p)
            ? updateButton(p.id, latest, "Update to latest")
            : "";
          const caption = projectName ? projectRelationCaption(p, projectName) : "";

          return `
        <tr data-package-id="${escapeHtml(p.id)}" data-severity="${escapeHtml(packageSeverity(p))}">
          <td>
            ${packageNameButton(p.id)}
            <span class="badge ${badgeClass}">${badgeText}</span>
            ${caption ? `<div>${escapeHtml(caption)}</div>` : ""}
          </td>
          <td>${escapeHtml(p.version)}</td>
          <td>${escapeHtml(latest || "—")}</td>
          ${showProjects ? `<td>${escapeHtml(formatProjectRelations(p))}</td>` : ""}
          <td>${rowButton}</td>
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
          severity: p.severity,
          projects: [...(p.projects || [])],
          isTransitive: p.isTransitive,
          transitiveProjects: [...(p.transitiveProjects || [])],
          transitiveOrigins: [...(p.transitiveOrigins || [])],
        };
      } else {
        if (!byPackage[key].severity && p.severity) {
          byPackage[key].severity = p.severity;
        }
        if (p.latestVersion && !byPackage[key].latestVersion) {
          byPackage[key].latestVersion = p.latestVersion;
        }
        for (const proj of p.projects || []) {
          if (!byPackage[key].projects.includes(proj)) {
            byPackage[key].projects.push(proj);
          }
        }
        if (!byPackage[key].transitiveProjects) {
          byPackage[key].transitiveProjects = [];
        }
        for (const project of p.transitiveProjects || []) {
          if (!byPackage[key].transitiveProjects.includes(project)) {
            byPackage[key].transitiveProjects.push(project);
          }
        }
        if (!byPackage[key].transitiveOrigins?.length && p.transitiveOrigins?.length) {
          byPackage[key].transitiveOrigins = [...p.transitiveOrigins];
        }
      }
    }

    const conflictHtml =
      conflictCount === 0
        ? `<p class="empty">No version conflicts</p>`
        : conflicts
          .map((c) => {

            const pkg = ScanState.getOutDated().find((p) => p.id.toLowerCase() === c.id.toLowerCase()) ||
              ScanState.getDeprecated().find((p) => p.id.toLowerCase() === c.id.toLowerCase()) ||
              ScanState.getVulnerable().find((p) => p.id.toLowerCase() === c.id.toLowerCase());

            const latest = pkg?.latestVersion || "";

            const alignBtn = latest && pkg
              ? updateButton(pkg.id, latest, `Align to ${latest}`)
              : "";

            const rows = c.versions
              .map(
                (v) => `
            <tr>
              <td>${escapeHtml(v.version)}</td>
              <td>${escapeHtml(v.projects.join(", "))}</td>
            </tr>
          `
              )
              .join("");

            return `
          <details open data-package-id="${escapeHtml(c.id)}" data-severity="${escapeHtml(packageSeverity({ id: c.id }))}">
            <summary>
              ${packageNameButton(c.id)} (${c.versions.length} different versions)
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
      <details class="filter-group" open>
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

      <details class="filter-group" open>
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
      <details class="filter-group" open>
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
      "deprecated"
    )}</tbody>
        </table>
      </details>
      <details class="filter-group" open>
      <summary><strong>Version Conflicts</strong> (${conflictCount})</summary>
        ${conflictHtml}
      </details>
    `;

    const byProjectHtml = Object.keys(byProject)
      .sort()
      .map((projectName) => {
        const rows = createRows(byProject[projectName], "outdated", projectName, false);
        return `
          <details class="filter-group" open>
            <summary><strong>${escapeHtml(projectName)}</strong> (${byProject[projectName].length})</summary>
            <table>
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Version</th>
                  <th>Latest</th>
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
          .map((proj: string) => {
            const relation = projectRelationCaption(p, proj);
            const text = relation ? `${proj} · ${relation}` : proj;
            return `<li>${escapeHtml(text)}</li>`;
          })
          .join("");

        const latest = p.latestVersion || "";
        const packageButton = latest && !graphOnlyWarning(p)
          ? updateButton(p.id, latest, "Update to latest")
          : "";

        return `
          <details class="filter-group" open data-package-id="${escapeHtml(p.id)}" data-severity="${escapeHtml(packageSeverity(p))}">
            <summary>
              ${packageNameButton(p.id)}
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
              <span class="muted"> ${escapeHtml(p.version)} → ${escapeHtml(latest || "—")}</span>
            </summary>
            <ul>${projectList}</ul>
            ${packageButton}
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PackageHub Dashboard</title>
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px 24px 32px;
      margin: 0;
    }
    .dash-head { margin-bottom: 18px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
    .scanned { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.7; }
    h2 { font-size: 1.05rem; margin: 24px 0 10px; }
    .cards {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .card {
      position: relative;
      overflow: hidden;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 12px 14px 12px 16px;
      min-width: 112px;
    }
    .card::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--vscode-foreground);
      opacity: 0.28;
    }
    .tone-vuln::before { background: var(--vscode-errorForeground); opacity: 1; }
    .tone-out::before { background: var(--vscode-editorWarning-foreground); opacity: 1; }
    .tone-dep::before { background: var(--vscode-charts-purple, var(--vscode-foreground)); opacity: 1; }
    .tone-ok::before { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-foreground))); opacity: 1; }
    .tone-info::before { background: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); opacity: 1; }
    .card-title {
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.7;
      margin-bottom: 4px;
    }
    .sources { margin: 0 0 14px; font-size: 0.85rem; color: var(--vscode-foreground); }
    .card-value { font-size: 1.45rem; font-weight: 650; line-height: 1.1; }
    .vulnerable { color: var(--vscode-errorForeground); }
    .outdated { color: var(--vscode-editorWarning-foreground); }
    .healthy { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-foreground))); }
    .deprecated { color: var(--vscode-charts-purple, var(--vscode-foreground)); }
    .conflicts { color: var(--vscode-textLink-foreground); }
    .view-switch { display: flex; gap: 0; margin-bottom: 16px; }
    .view-switch button {
      margin: 0;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 0;
      padding: 6px 12px;
    }
    .view-switch button + button { border-left: none; }
    .view-switch button:first-child { border-radius: 6px 0 0 6px; }
    .view-switch button:last-child { border-radius: 0 6px 6px 0; }
    .view-switch .active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      outline: none;
    }
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
    button.pkg-link {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: none;
      padding: 0;
      margin: 0;
      border-radius: 0;
      font-size: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button.pkg-link:hover {
      background: transparent;
      text-decoration: underline;
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
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .badge-out {
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-editorWarning-foreground);
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-widget-border));
    }
    .badge-dep {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid var(--vscode-widget-border);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      margin: 8px 0 4px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
    th { opacity: 0.7; font-weight: 500; font-size: 0.75rem; letter-spacing: 0.03em; text-transform: uppercase; }
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
    .safe-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .safe-actions button { margin-bottom: 0; }
    details {
      margin-bottom: 10px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      padding: 8px 12px 10px;
      background: var(--vscode-editorWidget-background);
    }
    summary {
      cursor: pointer;
      margin-bottom: 6px;
    }
    .row-btn { margin-bottom: 0; }
    .filters {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .filters input,
    .filters select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      font-family: var(--vscode-font-family);
      font-size: 0.9rem;
      padding: 4px 8px;
    }
    .filters input { min-width: 220px; }
    .hidden { display: none; }
    .filter-empty { opacity: 0.6; margin: 8px 0 16px; }
    .empty { opacity: 0.6; padding: 12px; }
    .muted { opacity: 0.7; font-size: 0.85rem; }
    .feed-failed td:first-child { border-left: 3px solid var(--vscode-errorForeground); }
    .hints { opacity: 0.85; }
    footer { margin-top: 24px; opacity: 0.7; font-size: 0.85rem; }
  </style>
</head>
<body>
  <header class="dash-head">
    <h1>PackageHub Health Dashboard</h1>
    ${scannedText ? `<p class="scanned">${escapeHtml(scannedText)}</p>` : ""}
  </header>

  <div class="cards">
    <div class="card tone-vuln">
      <div class="card-title">Vulnerable</div>
      <div class="card-value vulnerable">${vulnerableCount}</div>
    </div>
    <div class="card tone-out">
      <div class="card-title">Outdated</div>
      <div class="card-value outdated">${outdatedCount}</div>
    </div>
    <div class="card tone-dep">
      <div class="card-title">Deprecated</div>
      <div class="card-value deprecated">${deprecatedCount}</div>
    </div>
    <div class="card ${vulnerableCount + outdatedCount + deprecatedCount === 0 && !auditDataGap ? "tone-ok" : "tone-out"}">
      <div class="card-title">Status</div>
      <div class="card-value ${vulnerableCount + outdatedCount + deprecatedCount === 0 && !auditDataGap ? "healthy" : ""}">
        ${vulnerableCount + outdatedCount + deprecatedCount === 0 && !auditDataGap ? "Healthy" : "Needs Attention"}
      </div>
    </div>
    <div class="card tone-info">
      <div class="card-title">Conflicts</div>
      <div class="card-value conflicts">${conflictCount}</div>
    </div>
    <div class="card ${hasCpm ? "tone-ok" : ""}">
      <div class="card-title">CPM</div>
      <div class="card-value ${hasCpm ? "healthy" : ""}">
        ${hasCpm ? "Enabled" : "Not used"}
      </div>
    </div>
  </div>

  ${sourcesText ? `<p class="sources">${escapeHtml(sourcesText)}</p>` : ""}
  ${auditDataGap ? `<p class="sources">The audit source did not return vulnerability data.</p>` : ""}
  <p class="sources">${escapeHtml(advisoryText)}</p>

  <div class="safe-actions">
    <button type="button" data-action="refresh">Refresh Scan</button>
    <button type="button" data-action="safeUpdate" data-channel="patch">Highest patch</button>
    <button type="button" data-action="safeUpdate" data-channel="minor">Highest minor</button>
  </div>

  <div class="filters">
    <input id="pkg-search" type="search" placeholder="Package id" value="${escapeHtml(query)}" />
    <select id="pkg-severity">
      <option value="all"${severity === "all" ? " selected" : ""}>All</option>
      <option value="critical"${severity === "critical" ? " selected" : ""}>Critical</option>
      <option value="high"${severity === "high" ? " selected" : ""}>High</option>
      <option value="moderate"${severity === "moderate" ? " selected" : ""}>Moderate</option>
      <option value="low"${severity === "low" ? " selected" : ""}>Low</option>
    </select>
  </div>

  <div class="view-switch">
    <button type="button" class="${viewMode === "list" ? "active" : ""}" data-action="setViewMode" data-mode="list">List</button>
    <button type="button" class="${viewMode === "byProject" ? "active" : ""}" data-action="setViewMode" data-mode="byProject">By project</button>
    <button type="button" class="${viewMode === "byPackage" ? "active" : ""}" data-action="setViewMode" data-mode="byPackage">By package</button>
  </div>

  ${contentHtml}
  <p id="filter-empty" class="filter-empty hidden">No packages match the filter.</p>

  <details class="feed-health" open>
    <summary><strong>Feed Health</strong></summary>
    ${feedHtml}
  </details>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
      if (!target) {
        return;
      }
      const action = target.getAttribute("data-action");
      if (action === "showDependencies" || action === "updatePackage") {
        event.preventDefault();
        event.stopPropagation();
      }
      switch (action) {
        case "refresh":
          vscode.postMessage({ command: "refresh" });
          break;
        case "updatePackage":
          vscode.postMessage({
            command: "updatePackage",
            packageId: target.getAttribute("data-package") || "",
            version: target.getAttribute("data-version") || ""
          });
          break;
        case "showDependencies":
          vscode.postMessage({ command: "showDependencies", packageId: target.getAttribute("data-package") || "" });
          break;
        case "safeUpdate":
          vscode.postMessage({ command: "safeUpdate", channel: target.getAttribute("data-channel") || "" });
          break;
        case "setViewMode":
          vscode.postMessage({
            command: "setViewMode",
            mode: target.getAttribute("data-mode") || "",
            query: document.getElementById("pkg-search").value,
            severity: document.getElementById("pkg-severity").value
          });
          break;
      }
    });

    function publishFilter() {
      vscode.postMessage({
        command: "filter",
        query: document.getElementById("pkg-search").value,
        severity: document.getElementById("pkg-severity").value
      });
    }

    function applyFilter() {
      const q = document.getElementById("pkg-search").value.trim().toLowerCase();
      const sev = document.getElementById("pkg-severity").value;
      const filtering = q.length > 0 || sev !== "all";
      document.querySelectorAll("[data-package-id]").forEach((el) => {
        const id = (el.getAttribute("data-package-id") || "").toLowerCase();
        const itemSev = (el.getAttribute("data-severity") || "").toLowerCase();
        const ok = (!q || id.includes(q)) && (sev === "all" || itemSev === sev);
        el.classList.toggle("hidden", filtering && !ok);
      });
      let any = false;
      document.querySelectorAll(".filter-group").forEach((group) => {
        const own = group.matches("[data-package-id]") ? [group] : [];
        const items = own.concat(Array.from(group.querySelectorAll("[data-package-id]")));
        if (!filtering) {
          group.classList.remove("hidden");
          return;
        }
        if (items.length === 0) {
          group.classList.add("hidden");
          return;
        }
        const visible = items.some((el) => !el.classList.contains("hidden"));
        if (!group.matches("[data-package-id]")) {
          group.classList.toggle("hidden", !visible);
        }
        if (visible) {
          any = true;
        }
      });
      const empty = document.getElementById("filter-empty");
      const hasPackages = document.querySelector("[data-package-id]") !== null;
      if (empty) {
        empty.classList.toggle("hidden", !filtering || !hasPackages || any);
      }
    }

    document.getElementById("pkg-search").addEventListener("input", () => {
      applyFilter();
      publishFilter();
    });
    document.getElementById("pkg-severity").addEventListener("change", () => {
      applyFilter();
      publishFilter();
    });
    applyFilter();
  </script>
  <footer>
    <p>
      Ignored: ${ignoredCount}
      ${ignoredCount > 0 ? "(run PackageHub: Unignore Package to show them again)" : ""}
    </p>
    ${escapeHtml(scannedText)}
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