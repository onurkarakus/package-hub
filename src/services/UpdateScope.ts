import { isNewerVersion } from "../utils/nugetAudit";

const MAX_SCOPED_PROJECTS = 500;

/**
 * Reads the optional `projects` argument of an update command. Returns the
 * lowercased names, or undefined when the argument is missing or malformed,
 * which leaves the update unscoped. An empty list is a scope with no
 * projects in it.
 */
export function projectScope(value: unknown): Set<string> | undefined {
    if (!Array.isArray(value) || value.length > MAX_SCOPED_PROJECTS) {
        return undefined;
    }
    if (!value.every((name) => typeof name === "string" && name.length > 0 && name.length <= 260)) {
        return undefined;
    }
    return new Set((value as string[]).map((name) => name.toLowerCase()));
}

/**
 * Splits update targets into the ones to write and the ones already on a
 * newer version than `version`. Writing those would be a downgrade. A target
 * whose current version is unknown or not comparable is kept, as before.
 */
export function withoutDowngrades<T>(
    targets: T[],
    version: string | undefined,
    currentOf: (target: T) => string | undefined
): { kept: T[]; skipped: (T & { from: string })[] } {
    if (!version) {
        return { kept: targets, skipped: [] };
    }
    const kept: T[] = [];
    const skipped: (T & { from: string })[] = [];
    for (const target of targets) {
        const from = currentOf(target);
        let downgrade = false;
        if (from) {
            try {
                downgrade = isNewerVersion(from, version);
            } catch {
                downgrade = false;
            }
        }
        if (downgrade && from) {
            skipped.push({ ...target, from });
        } else {
            kept.push(target);
        }
    }
    return { kept, skipped };
}
