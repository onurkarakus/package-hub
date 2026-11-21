import { l10n } from "vscode";
import { compareNuGetVersions, isComparableVersion, parseNuGetVersion, versionInsideRange } from "../utils/nugetAudit";

/**
 * What a Version attribute holds: one exact version, a range, a floating
 * version, an MSBuild property, or something PackageHub cannot read.
 */
export type VersionSpec =
    | { kind: "exact"; text: string }
    | { kind: "range"; text: string; min?: string; minInclusive: boolean; max?: string; maxInclusive: boolean }
    | { kind: "floating"; text: string; prefix: string }
    | { kind: "property"; text: string; name: string }
    | { kind: "unknown"; text: string };

const PROPERTY = /^\$\(\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\)$/;

export function readVersionSpec(raw: string | undefined): VersionSpec {
    const text = (raw ?? "").trim();
    const property = PROPERTY.exec(text);
    if (property) {
        return { kind: "property", text, name: property[1] };
    }
    if (isComparableVersion(text)) {
        return { kind: "exact", text };
    }
    if (/^\d+(\.\d+){0,3}(\.\*|-\*)$|^\*$|^\d+(\.\d+){0,3}-[0-9A-Za-z.-]*\*$/.test(text)) {
        return { kind: "floating", text, prefix: text.replace(/\*$/, "") };
    }
    if ((text.startsWith("[") || text.startsWith("(")) && (text.endsWith("]") || text.endsWith(")"))) {
        const body = text.slice(1, -1);
        if (!body.includes(",")) {
            const single = body.trim();
            if (text.startsWith("[") && text.endsWith("]") && isComparableVersion(single)) {
                return { kind: "range", text, min: single, minInclusive: true, max: single, maxInclusive: true };
            }
            return { kind: "unknown", text };
        }
        const comma = body.indexOf(",");
        const min = body.slice(0, comma).trim() || undefined;
        const max = body.slice(comma + 1).trim() || undefined;
        if ((min && !isComparableVersion(min)) || (max && !isComparableVersion(max)) || (!min && !max)) {
            return { kind: "unknown", text };
        }
        return {
            kind: "range",
            text,
            min,
            minInclusive: text.startsWith("["),
            max,
            maxInclusive: text.endsWith("]"),
        };
    }
    return { kind: "unknown", text };
}

/**
 * True when a floating version such as `1.*`, `1.2.*` or `1.0.0-beta*` can
 * resolve to the given version.
 */
export function floatingAllows(prefix: string, version: string): boolean {
    if (!isComparableVersion(version)) {
        return false;
    }
    if (prefix === "") {
        return true;
    }
    const target = version.trim().toLowerCase().replace(/\+.*$/, "");
    const head = prefix.toLowerCase();
    if (head.endsWith("-")) {
        return target.startsWith(head);
    }
    if (!head.endsWith(".")) {
        return target.startsWith(head);
    }
    const parsed = parseNuGetVersion(target);
    if (!parsed || parsed.prerelease.length > 0) {
        return false;
    }
    const wanted = head.slice(0, -1).split(".").map(Number);
    return wanted.every((part, index) => parsed.release[index] === part);
}

/**
 * How to write a new version over what the file holds now.
 *
 * - exact: write the version.
 * - range: keep the range and move its lower bound up to the version, so
 *   restore picks it. A version outside the range is refused.
 * - floating: nothing to write when the floating version already covers the
 *   version; restore picks the newest match. Otherwise refused.
 * - property: the property definition is edited instead (see
 *   findPropertyDefinition).
 */
export type VersionWrite =
    | { kind: "write"; text: string }
    | { kind: "restore-only"; reason: string }
    | { kind: "property"; name: string }
    | { kind: "refused"; reason: string };

export function planVersionWrite(raw: string | undefined, target: string): VersionWrite {
    const spec = readVersionSpec(raw);
    switch (spec.kind) {
        case "exact":
            return { kind: "write", text: target };
        case "property":
            return { kind: "property", name: spec.name };
        case "floating":
            return floatingAllows(spec.prefix, target)
                ? { kind: "restore-only", reason: l10n.t("{0} already allows {1}. Restore picks it.", spec.text, target) }
                : { kind: "refused", reason: l10n.t("{0} is outside the floating version {1}. Edit the version by hand to leave it.", target, spec.text) };
        case "range": {
            if (versionInsideRange(target, spec.text) !== true) {
                return { kind: "refused", reason: l10n.t("{0} is outside the range {1}. Updates stay inside the range.", target, spec.text) };
            }
            if (spec.min && spec.max && spec.min === spec.max) {
                return { kind: "write", text: `[${target}]` };
            }
            if (spec.min && compareNuGetVersions(spec.min, target) === 0 && spec.minInclusive) {
                return { kind: "restore-only", reason: l10n.t("{0} already starts at {1}.", spec.text, target) };
            }
            const upper = spec.max ? `${spec.max}${spec.maxInclusive ? "]" : ")"}` : ")";
            return { kind: "write", text: `[${target}, ${upper}` };
        }
        default:
            return { kind: "refused", reason: l10n.t("\"{0}\" is not a version PackageHub can change. Edit it by hand.", spec.text) };
    }
}

export interface PropertyDefinition {
    filePath: string;
    value: string;
}

/**
 * Finds the last plain definition of an MSBuild property in the given files,
 * read in import order (the last one wins, as in MSBuild). Conditions are not
 * evaluated, so a property defined under a Condition is reported as unknown.
 */
export function findPropertyDefinition(
    files: { filePath: string; text: string }[],
    name: string
): PropertyDefinition | "conditional" | undefined {
    let found: PropertyDefinition | "conditional" | undefined;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<${escaped}(\\s[^>]*)?>([^<]*)</${escaped}\\s*>`, "gi");
    for (const file of files) {
        const masked = file.text.replace(/<!--[\s\S]*?(-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
        for (const match of masked.matchAll(pattern)) {
            const before = masked.slice(0, match.index ?? 0);
            const group = before.lastIndexOf("<PropertyGroup");
            const groupTag = group >= 0 ? masked.slice(group, masked.indexOf(">", group) + 1) : "";
            const conditional = /\bCondition\s*=/.test(match[1] ?? "") || /\bCondition\s*=/.test(groupTag);
            found = conditional ? "conditional" : { filePath: file.filePath, value: match[2].trim() };
        }
    }
    return found;
}

/**
 * Sets the value of every plain definition of a property in MSBuild XML.
 * Returns undefined when the property is not defined there.
 */
export function setPropertyInXml(xml: string, name: string, value: string): string | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(<${escaped}(?:\\s[^>]*)?>)([^<]*)(</${escaped}\\s*>)`, "gi");
    const masked = xml.replace(/<!--[\s\S]*?(-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
    let result = "";
    let cursor = 0;
    let changed = false;
    for (const match of masked.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[1].length;
        const end = start + match[2].length;
        result += xml.slice(cursor, start) + value;
        cursor = end;
        changed = true;
    }
    if (!changed) {
        return undefined;
    }
    return result + xml.slice(cursor);
}
