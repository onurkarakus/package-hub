import * as vscode from "vscode";

export interface DotnetTimeouts {
    listMs: number;
    outdatedMs: number;
    restoreMs: number;
}

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("packageHub");
}

function seconds(name: string, fallback: number, minimum: number): number {
    const value = config().get<number>(name);
    const picked = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(minimum, picked) * 1000;
}

/**
 * True only when the user turned on packageHub.onlineLookups. Off by default:
 * PackageHub then makes no network request of its own.
 */
export function onlineLookupsEnabled(): boolean {
    return config().get<boolean>("onlineLookups") === true;
}

export function dotnetTimeouts(): DotnetTimeouts {
    return {
        listMs: seconds("timeouts.listSeconds", 120, 10),
        outdatedMs: seconds("timeouts.outdatedSeconds", 300, 10),
        restoreMs: seconds("timeouts.restoreSeconds", 600, 10),
    };
}

export function maxDotnetProcesses(): number {
    const value = config().get<number>("maxDotnetProcesses");
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 4;
    }
    return Math.min(16, Math.max(1, Math.floor(value)));
}

export function minimumReleaseAgeDays(): number {
    const value = config().get<number>("minimumReleaseAge");
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export const DASHBOARD_VIEW_MODES = ["list", "byProject", "byPackage"] as const;
export type DashboardViewMode = (typeof DASHBOARD_VIEW_MODES)[number];

export function isDashboardViewMode(value: unknown): value is DashboardViewMode {
    return typeof value === "string" && (DASHBOARD_VIEW_MODES as readonly string[]).includes(value);
}

export function dashboardViewMode(): DashboardViewMode {
    const value = config().get<string>("dashboardViewMode");
    return isDashboardViewMode(value) ? value : "list";
}
