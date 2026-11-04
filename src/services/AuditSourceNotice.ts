import * as fs from "fs/promises";
import { assetsFileFor } from "./AssetsLocator";
import { FeedFailure, feedFailuresFromAssetsLogs } from "./FeedHealth";

export function logsHaveAuditDataGap(logs: unknown): boolean {
    if (!Array.isArray(logs)) {
        return false;
    }

    return logs.some((entry) => {
        if (!entry || typeof entry !== "object") {
            return false;
        }
        const code = (entry as { code?: unknown }).code;
        return typeof code === "string" && code.toUpperCase() === "NU1905";
    });
}

export interface RestoreLogSummary {
    auditDataGap: boolean;
    feedFailures: FeedFailure[];
}

/**
 * Reads the restore logs in each project.assets.json: the audit data gap
 * (NU1905) and feed failures (NU1301, NU1801, NU1900...). Local files only.
 */
export async function readRestoreLogs(projectPaths: string[]): Promise<RestoreLogSummary> {
    const summary: RestoreLogSummary = { auditDataGap: false, feedFailures: [] };
    for (const projectPath of projectPaths) {
        try {
            const text = await fs.readFile(await assetsFileFor(projectPath), "utf8");
            const root = JSON.parse(text) as { logs?: unknown };
            if (logsHaveAuditDataGap(root?.logs)) {
                summary.auditDataGap = true;
            }
            summary.feedFailures.push(...feedFailuresFromAssetsLogs(root?.logs));
        } catch {
            continue;
        }
    }
    return summary;
}

export async function workspaceHasAuditDataGap(projectPaths: string[]): Promise<boolean> {
    return (await readRestoreLogs(projectPaths)).auditDataGap;
}
