import * as fs from "fs/promises";
import * as path from "path";

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

export async function workspaceHasAuditDataGap(projectPaths: string[]): Promise<boolean> {
    for (const projectPath of projectPaths) {
        const assetsPath = path.join(path.dirname(projectPath), "obj", "project.assets.json");
        try {
            const text = await fs.readFile(assetsPath, "utf8");
            const root = JSON.parse(text) as { logs?: unknown };
            if (logsHaveAuditDataGap(root?.logs)) {
                return true;
            }
        } catch {
            continue;
        }
    }

    return false;
}
