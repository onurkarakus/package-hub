export const AUDIT_CODES = ["NU1901", "NU1902", "NU1903", "NU1904"] as const;

export type AuditCode = (typeof AUDIT_CODES)[number];

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
    if (!/PackageReference|PackageVersion/i.test(line)) {
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
        kind: /PackageVersion/i.test(line) ? "version" : "reference",
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
