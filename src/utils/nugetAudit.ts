export const AUDIT_CODES = ["NU1901", "NU1902", "NU1903", "NU1904"] as const;

export type AuditCode = (typeof AUDIT_CODES)[number];

const SEVERITY_RANK = ["low", "moderate", "high", "critical"];

export function meetsMinimumSeverity(severity: string | undefined, minimum: string | undefined): boolean {
    const floor = SEVERITY_RANK.indexOf((minimum || "low").toLowerCase());
    const rank = SEVERITY_RANK.indexOf((severity || "").toLowerCase());
    if (floor < 0 || rank < 0) {
        return true;
    }

    return rank >= floor;
}

export function auditCodeForSeverity(severity?: string): AuditCode {
    switch ((severity || "").toLowerCase()) {
        case "low":
            return "NU1901";
        case "high":
            return "NU1903";
        case "critical":
            return "NU1904";
        default:
            return "NU1902";
    }
}

export function isAuditCode(code: string | undefined): code is AuditCode {
    return !!code && (AUDIT_CODES as readonly string[]).includes(code);
}

export function readDiagnosticCode(
    code: string | number | { value: string | number } | undefined
): string | undefined {
    if (code === undefined) {
        return undefined;
    }

    if (typeof code === "string" || typeof code === "number") {
        return String(code);
    }

    return String(code.value);
}

export function readPackageRef(line: string): {
    id: string;
    version?: string;
    kind: "reference" | "version";
} | undefined {
    const tag = /<(GlobalPackageReference|PackageReference|PackageVersion)\b/i.exec(line);
    if (!tag) {
        return undefined;
    }

    const include = line.match(/Include\s*=\s*"([^"]+)"/i);
    if (!include) {
        return undefined;
    }

    const version = line.match(/Version\s*=\s*"([^"]+)"/i);

    return {
        id: include[1],
        version: version?.[1],
        kind: tag[1].toLowerCase() === "packageversion" ? "version" : "reference",
    };
}

export function parseAdvisoryPackage(message: string): { id: string; version?: string } | undefined {
    const match = message.match(/Package '([^']+)'(?:\s+([^\s,]+))?/i);
    if (!match) {
        return undefined;
    }

    return {
        id: match[1],
        version: match[2],
    };
}

export function advisoryUrlIn(message: string): string | undefined {
    const match = message.match(/https:\/\/\S+/);
    return match?.[0];
}

export function chooseQuickFixVersions(
    current: string | undefined,
    patch: string | undefined,
    latest: string | undefined
): { patch?: string; latest?: string } {
    const newerThanCurrent = (candidate: string | undefined) =>
        !!candidate && (!current || compareNuGetVersions(candidate, current) > 0);

    const patchTarget = newerThanCurrent(patch) ? patch : undefined;
    const latestTarget = newerThanCurrent(latest)
        && (!patchTarget || compareNuGetVersions(latest as string, patchTarget) > 0)
        ? latest
        : undefined;

    return {
        patch: patchTarget,
        latest: latestTarget,
    };
}

export function isSafeChannelTarget(
    current: string | undefined,
    candidate: string | undefined,
    channel: "patch" | "minor"
): boolean {
    if (!current || !candidate || compareNuGetVersions(candidate, current) <= 0) {
        return false;
    }

    const left = versionParts(current);
    const right = versionParts(candidate);
    if ((left[0] ?? 0) !== (right[0] ?? 0)) {
        return false;
    }

    if (channel === "patch" && (left[1] ?? 0) !== (right[1] ?? 0)) {
        return false;
    }

    return true;
}

function versionParts(value: string): number[] {
    const cleaned = value.trim().replace(/^\[|\]$/g, "");
    const [main] = cleaned.split("-", 2);
    return main.split(".").map((part) => {
        const numeric = parseInt(part, 10);
        return Number.isFinite(numeric) ? numeric : 0;
    });
}

export function exclusiveUpperBound(range: string): string | undefined {
    const text = range.trim();
    if (!text || text.includes("*") || !text.endsWith(")")) {
        return undefined;
    }

    if (!text.startsWith("[") && !text.startsWith("(")) {
        return undefined;
    }

    const body = text.slice(1, -1).trim();
    if (!body.includes(",")) {
        return undefined;
    }

    const max = body.slice(body.indexOf(",") + 1).trim();
    if (!max || !/^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(max)) {
        return undefined;
    }

    return max;
}

export function firstFixedFromRanges(ranges: string[], current?: string): string | undefined {
    if (ranges.length === 0) {
        return undefined;
    }

    const bounds: string[] = [];
    for (const range of ranges) {
        const upper = exclusiveUpperBound(range);
        if (!upper || versionInsideRange(upper, range) !== false) {
            return undefined;
        }
        bounds.push(upper);
    }

    bounds.sort((left, right) => compareNuGetVersions(left, right));
    for (const candidate of bounds) {
        if (current && compareNuGetVersions(candidate, current) <= 0) {
            continue;
        }

        const outside = ranges.every((range) => versionInsideRange(candidate, range) === false);
        if (outside) {
            return candidate;
        }
    }

    return undefined;
}

export function sameNuGetVersion(left: string | undefined, right: string | undefined): boolean {
    return !!left && !!right && compareNuGetVersions(left, right) === 0;
}

export function versionInsideRange(version: string, range: string): boolean | undefined {
    const text = range.trim();
    if (!text || text.includes("*")) {
        return undefined;
    }

    if (text.startsWith("[") || text.startsWith("(")) {
        if (!text.endsWith("]") && !text.endsWith(")")) {
            return undefined;
        }

        const minInclusive = text.startsWith("[");
        const maxInclusive = text.endsWith("]");
        const body = text.slice(1, -1).trim();
        if (!body.includes(",")) {
            if (!minInclusive || !maxInclusive || !body) {
                return undefined;
            }
            return compareNuGetVersions(version, body) === 0;
        }

        const comma = body.indexOf(",");
        const min = body.slice(0, comma).trim();
        const max = body.slice(comma + 1).trim();
        if (!min && !max) {
            return undefined;
        }
        if (min) {
            const compared = compareNuGetVersions(version, min);
            if (minInclusive ? compared < 0 : compared <= 0) {
                return false;
            }
        }
        if (max) {
            const compared = compareNuGetVersions(version, max);
            if (maxInclusive ? compared > 0 : compared >= 0) {
                return false;
            }
        }
        return true;
    }

    if (/\s/.test(text)) {
        return undefined;
    }

    return compareNuGetVersions(version, text) >= 0;
}

export function compareNuGetVersions(left: string, right: string): number {
    const split = (value: string) => {
        const cleaned = value.trim().replace(/^\[|\]$/g, "");
        const [main, pre] = cleaned.split("-", 2);
        const parts = main.split(".").map((part) => {
            const numeric = parseInt(part, 10);
            return Number.isFinite(numeric) ? numeric : 0;
        });
        return { parts, pre };
    };

    const a = split(left);
    const b = split(right);
    const length = Math.max(a.parts.length, b.parts.length);

    for (let i = 0; i < length; i++) {
        const av = a.parts[i] ?? 0;
        const bv = b.parts[i] ?? 0;
        if (av !== bv) {
            return av - bv;
        }
    }

    if (a.pre && !b.pre) {
        return -1;
    }

    if (!a.pre && b.pre) {
        return 1;
    }

    if (a.pre && b.pre && a.pre !== b.pre) {
        return a.pre < b.pre ? -1 : 1;
    }

    return 0;
}
