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

export type Severity = "Critical" | "High" | "Moderate" | "Low";

/**
 * Reads a severity from dotnet JSON (text) or from NuGet vulnerability data
 * (0 low, 1 moderate, 2 high, 3 critical). Anything else is unknown.
 */
export function normalizeSeverity(raw: unknown): Severity | undefined {
    if (typeof raw === "number") {
        return (["Low", "Moderate", "High", "Critical"] as const)[raw];
    }
    if (typeof raw !== "string") {
        return undefined;
    }
    switch (raw.trim().toLowerCase()) {
        case "critical":
            return "Critical";
        case "high":
            return "High";
        case "moderate":
        case "medium":
            return "Moderate";
        case "low":
            return "Low";
        default:
            return undefined;
    }
}

/**
 * Higher is worse. An unknown severity ranks below low, so it never hides a
 * known severity.
 */
export function severityRank(severity: string | undefined): number {
    const known = normalizeSeverity(severity);
    return known ? SEVERITY_RANK.indexOf(known.toLowerCase()) + 1 : 0;
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

export type PackageRefTag = "PackageReference" | "PackageVersion" | "GlobalPackageReference";

export interface PackageRef {
    id: string;
    version?: string;
    kind: "reference" | "version";
}

export interface PackageRefLocation extends PackageRef {
    tag: PackageRefTag;
    /** Include or Update. */
    attribute: "Include" | "Update";
    /** The value written in Version (attribute or child element). */
    declaredVersion?: string;
    /** The value written in VersionOverride (attribute or child element). */
    versionOverride?: string;
    /** First line of the element (0-based). */
    line: number;
    /** Last line of the element (0-based). */
    endLine: number;
}

/**
 * Replaces XML comments with spaces. Newlines stay, so offsets and line
 * numbers still match the original text.
 */
export function maskXmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?(-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

const ELEMENT_PATTERN =
    /<(GlobalPackageReference|PackageReference|PackageVersion)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;

function canonicalTag(tag: string): PackageRefTag {
    switch (tag.toLowerCase()) {
        case "packageversion":
            return "PackageVersion";
        case "globalpackagereference":
            return "GlobalPackageReference";
        default:
            return "PackageReference";
    }
}

function readAttribute(attributes: string, name: string): string | undefined {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
    const match = pattern.exec(attributes);
    if (!match) {
        return undefined;
    }
    const value = (match[1] ?? match[2] ?? "").trim();
    return value ? value : undefined;
}

function readChildElement(body: string | undefined, name: string): string | undefined {
    if (!body) {
        return undefined;
    }
    const match = new RegExp(`<${name}\\s*>([^<]*)<\\/${name}\\s*>`, "i").exec(body);
    const value = match?.[1].trim();
    return value ? value : undefined;
}

function countNewlines(text: string, end = text.length): number {
    let count = 0;
    for (let index = 0; index < end; index += 1) {
        if (text.charCodeAt(index) === 10) {
            count += 1;
        }
    }
    return count;
}

function buildLocation(
    tagName: string,
    attributes: string,
    body: string | undefined,
    line: number,
    endLine: number
): PackageRefLocation | undefined {
    const include = readAttribute(attributes, "Include");
    const update = include ? undefined : readAttribute(attributes, "Update");
    const id = include || update;
    if (!id) {
        return undefined;
    }

    const tag = canonicalTag(tagName);
    const declaredVersion = readAttribute(attributes, "Version") ?? readChildElement(body, "Version");
    const versionOverride = readAttribute(attributes, "VersionOverride") ?? readChildElement(body, "VersionOverride");
    const location: PackageRefLocation = {
        id,
        version: versionOverride ?? declaredVersion,
        kind: tag === "PackageVersion" ? "version" : "reference",
        tag,
        attribute: include ? "Include" : "Update",
        line,
        endLine,
    };
    if (declaredVersion !== undefined) {
        location.declaredVersion = declaredVersion;
    }
    if (versionOverride !== undefined) {
        location.versionOverride = versionOverride;
    }
    return location;
}

/**
 * Reads every PackageReference, PackageVersion and GlobalPackageReference in an
 * MSBuild file. XML comments are ignored, single and double quotes both work,
 * Include and Update both work, and an element may span several lines. A
 * Version or VersionOverride child element is read as well.
 */
export function readPackageRefs(text: string): PackageRefLocation[] {
    const masked = maskXmlComments(text);
    const found: PackageRefLocation[] = [];
    ELEMENT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lineCursor = 0;
    let offsetCursor = 0;
    while ((match = ELEMENT_PATTERN.exec(masked)) !== null) {
        lineCursor += countNewlines(masked.slice(offsetCursor, match.index));
        offsetCursor = match.index;
        const endLine = lineCursor + countNewlines(match[0]);
        const location = buildLocation(match[1], match[2], match[4], lineCursor, endLine);
        if (location) {
            found.push(location);
        }
    }
    return found;
}

/**
 * Finds the package element that covers a line of a document.
 */
export function packageRefAtLine(text: string, line: number): PackageRefLocation | undefined {
    return readPackageRefs(text).find((ref) => ref.line <= line && line <= ref.endLine);
}

/**
 * Reads a package element from one line. When the line holds only the start of
 * a multi-line element, the attributes on that line are still read.
 */
export function readPackageRef(line: string): PackageRef | undefined {
    const masked = maskXmlComments(line);
    const full = readPackageRefs(masked)[0];
    const partial = full ? undefined : partialPackageRef(masked);
    const ref = full || partial;
    if (!ref) {
        return undefined;
    }
    return { id: ref.id, version: ref.version, kind: ref.kind };
}

function partialPackageRef(line: string): PackageRefLocation | undefined {
    const tag = /<(GlobalPackageReference|PackageReference|PackageVersion)\b([^>]*)$/i.exec(line)
        || /<(GlobalPackageReference|PackageReference|PackageVersion)\b([^>]*)>/i.exec(line);
    if (!tag) {
        return undefined;
    }
    return buildLocation(tag[1], tag[2], undefined, 0, 0);
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
    const newerThanCurrent = (candidate: string | undefined) => {
        if (!candidate || !isComparableVersion(candidate)) {
            return false;
        }
        if (!current) {
            return true;
        }
        return isNewerVersion(candidate, current);
    };

    const patchTarget = newerThanCurrent(patch) ? patch : undefined;
    const latestTarget = newerThanCurrent(latest)
        && (!patchTarget || isNewerVersion(latest as string, patchTarget))
        ? latest
        : undefined;

    return {
        patch: patchTarget,
        latest: latestTarget,
    };
}

/**
 * True when candidate is a safe bulk target for the channel.
 * Both versions must be exact NuGet versions. The major must stay the same,
 * and for patch the minor must stay the same too. A prerelease is never a patch
 * target. A prerelease is a minor target only when the current version is a
 * prerelease already.
 */
export function isSafeChannelTarget(
    current: string | undefined,
    candidate: string | undefined,
    channel: "patch" | "minor"
): boolean {
    const left = current ? parseNuGetVersion(current) : undefined;
    const right = candidate ? parseNuGetVersion(candidate) : undefined;
    if (!left || !right || compareParsed(right, left) <= 0) {
        return false;
    }

    if (left.release[0] !== right.release[0]) {
        return false;
    }

    if (right.prerelease.length > 0) {
        if (channel === "patch" || left.prerelease.length === 0) {
            return false;
        }
    }

    if (channel === "patch" && left.release[1] !== right.release[1]) {
        return false;
    }

    return true;
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
    if (!max || !isComparableVersion(max)) {
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

    bounds.sort((left, right) => compareNuGetVersions(left, right) || 0);
    for (const candidate of bounds) {
        if (current && !isNewerVersion(candidate, current)) {
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
    if (!text || text.includes("*") || !isComparableVersion(version)) {
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
            if (!minInclusive || !maxInclusive || !body || !isComparableVersion(body)) {
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
        if ((min && !isComparableVersion(min)) || (max && !isComparableVersion(max))) {
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

    if (!isComparableVersion(text)) {
        return undefined;
    }

    return compareNuGetVersions(version, text) >= 0;
}

export interface NuGetVersion {
    /** Four numeric parts: major, minor, patch, revision. */
    release: [number, number, number, number];
    /** Dot-separated prerelease labels, empty for a stable version. */
    prerelease: string[];
}

const VERSION_PATTERN =
    /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Parses an exact NuGet version. Ranges such as `[1.0,2.0)`, floating versions
 * such as `1.*`, MSBuild properties such as `$(Version)` and anything else that
 * is not one exact version return undefined. Build metadata after `+` is
 * dropped.
 */
export function parseNuGetVersion(value: string | undefined): NuGetVersion | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const match = VERSION_PATTERN.exec(value.trim());
    if (!match) {
        return undefined;
    }

    const parts = [match[1], match[2], match[3], match[4]].map((part) => (part === undefined ? 0 : Number(part)));
    if (parts.some((part) => !Number.isSafeInteger(part))) {
        return undefined;
    }

    return {
        release: parts as [number, number, number, number],
        prerelease: match[5] ? match[5].split(".") : [],
    };
}

export function isComparableVersion(value: string | undefined): boolean {
    return parseNuGetVersion(value) !== undefined;
}

export function isPrereleaseVersion(value: string | undefined): boolean {
    const parsed = parseNuGetVersion(value);
    return !!parsed && parsed.prerelease.length > 0;
}

function compareLabel(left: string, right: string): number {
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
        const a = BigInt(left);
        const b = BigInt(right);
        return a === b ? 0 : a < b ? -1 : 1;
    }
    if (leftNumeric) {
        return -1;
    }
    if (rightNumeric) {
        return 1;
    }
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a === b ? 0 : a < b ? -1 : 1;
}

function compareParsed(left: NuGetVersion, right: NuGetVersion): number {
    for (let index = 0; index < 4; index += 1) {
        if (left.release[index] !== right.release[index]) {
            return left.release[index] < right.release[index] ? -1 : 1;
        }
    }

    const a = left.prerelease;
    const b = right.prerelease;
    if (a.length === 0 && b.length === 0) {
        return 0;
    }
    if (a.length === 0) {
        return 1;
    }
    if (b.length === 0) {
        return -1;
    }

    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const compared = compareLabel(a[index], b[index]);
        if (compared !== 0) {
            return compared;
        }
    }

    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Compares two exact NuGet versions with NuGet's rules: four numeric parts,
 * stable after prerelease, dot-separated prerelease labels where numeric labels
 * compare as numbers and other labels compare case-insensitively, build
 * metadata ignored.
 *
 * Returns -1, 0 or 1. Returns NaN when either side is not an exact version
 * (a range, a floating version or an MSBuild property), so every `<`, `>` and
 * `===` check is false for such input.
 */
export function compareNuGetVersions(left: string, right: string): number {
    const a = parseNuGetVersion(left);
    const b = parseNuGetVersion(right);
    if (!a || !b) {
        return Number.NaN;
    }
    return compareParsed(a, b);
}

export function isNewerVersion(candidate: string, current: string): boolean {
    return compareNuGetVersions(candidate, current) > 0;
}

export type VersionChange = "major" | "minor" | "patch" | "revision" | "prerelease" | "same" | "downgrade" | "unknown";

/**
 * Names the kind of change from one exact version to another.
 */
export function versionChange(from: string | undefined, to: string | undefined): VersionChange {
    const a = parseNuGetVersion(from);
    const b = parseNuGetVersion(to);
    if (!a || !b) {
        return "unknown";
    }
    const compared = compareParsed(b, a);
    if (compared === 0) {
        return "same";
    }
    if (compared < 0) {
        return "downgrade";
    }
    if (a.release[0] !== b.release[0]) {
        return "major";
    }
    if (a.release[1] !== b.release[1]) {
        return "minor";
    }
    if (a.release[2] !== b.release[2]) {
        return "patch";
    }
    if (a.release[3] !== b.release[3]) {
        return "revision";
    }
    return "prerelease";
}

const PACKAGE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * True for a NuGet package id that is safe to pass to dotnet.
 */
export function isValidPackageId(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 100
        && PACKAGE_ID_PATTERN.test(value)
        && !value.startsWith("-")
        && !value.startsWith(".");
}

/**
 * True for an exact NuGet version that is safe to pass to dotnet.
 */
export function isValidPackageVersion(value: unknown): value is string {
    return typeof value === "string"
        && value.length <= 128
        && VERSION_PATTERN.test(value)
        && !value.startsWith("-");
}

/**
 * The highest version with the same major and minor as current, newer than
 * current. Prereleases count only when includePrerelease is on.
 */
export function highestPatchFrom(
    current: string | undefined,
    versions: readonly string[],
    includePrerelease = false
): string | undefined {
    const base = parseNuGetVersion(current);
    if (!base) {
        return undefined;
    }
    let best: { text: string; parsed: NuGetVersion } | undefined;
    for (const text of versions) {
        const parsed = parseNuGetVersion(text);
        if (!parsed || parsed.release[0] !== base.release[0] || parsed.release[1] !== base.release[1]) {
            continue;
        }
        if (parsed.prerelease.length > 0 && !includePrerelease) {
            continue;
        }
        if (compareParsed(parsed, base) <= 0) {
            continue;
        }
        if (!best || compareParsed(parsed, best.parsed) > 0) {
            best = { text, parsed };
        }
    }
    return best?.text;
}
