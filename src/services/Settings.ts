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

/**
 * True unless the user turned off packageHub.rollbackOnFailure. When on, a
 * batch of writes that fails half way puts every file back.
 */
export function rollbackEnabled(): boolean {
    return config().get<boolean>("rollbackOnFailure") !== false;
}

export type BadgeMode = "vulnerable" | "vulnerableAndOutdated" | "all" | "off";

export function badgeMode(): BadgeMode {
    const value = config().get<string>("badge");
    return value === "vulnerableAndOutdated" || value === "all" || value === "off" ? value : "vulnerable";
}
