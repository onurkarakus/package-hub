import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { l10n } from "vscode";
import { compareNuGetVersions, parseNuGetVersion } from "../utils/nugetAudit";

/**
 * Reads package metadata from the .nuspec files NuGet keeps in the global
 * packages folder. Nothing here makes a network request; the online fallback
 * is passed in by the caller and runs only when packageHub.onlineLookups is on.
 */

export interface NuspecDependency {
    id: string;
    range?: string;
}

export interface NuspecGroup {
    framework: string;
    dependencies: NuspecDependency[];
}

export interface NuspecInfo {
    id: string;
    version: string;
    description?: string;
    license?: string;
    licenseUrl?: string;
    releaseNotes?: string;
    projectUrl?: string;
    groups: NuspecGroup[];
}

function decodeXml(value: string): string {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/g, "&");
}

function element(xml: string, name: string): { attributes: string; body: string } | undefined {
    const match = new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, "i").exec(xml);
    if (!match) {
        return undefined;
    }
    return { attributes: match[1] ?? "", body: match[2] ?? "" };
}

function attribute(attributes: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
    const value = match ? (match[1] ?? match[2] ?? "").trim() : "";
    return value ? decodeXml(value) : undefined;
}

function text(xml: string, name: string): string | undefined {
    const found = element(xml, name);
    const value = found ? decodeXml(found.body).trim() : "";
    return value ? value : undefined;
}

/**
 * Parses the metadata of a .nuspec file. Returns undefined when the text has
 * no package id.
 */
export function parseNuspec(xml: string): NuspecInfo | undefined {
    const metadata = element(xml.replace(/<!--[\s\S]*?-->/g, ""), "metadata")?.body;
    if (!metadata) {
        return undefined;
    }
    const id = text(metadata, "id");
    const version = text(metadata, "version");
    if (!id || !version) {
        return undefined;
    }
    const license = element(metadata, "license");
    const groups: NuspecGroup[] = [];
    const dependencies = element(metadata, "dependencies")?.body ?? "";
    const readDeps = (body: string): NuspecDependency[] => {
        const deps: NuspecDependency[] = [];
        for (const match of body.matchAll(/<dependency\b([^>]*?)\/?>/gi)) {
            const depId = attribute(match[1], "id");
            if (depId) {
                deps.push({ id: depId, range: attribute(match[1], "version") });
            }
        }
        return deps;
    };
    let grouped = false;
    for (const match of dependencies.matchAll(/<group\b([^>]*?)(?:\/>|>([\s\S]*?)<\/group\s*>)/gi)) {
        grouped = true;
        groups.push({ framework: attribute(match[1], "targetFramework") ?? "", dependencies: readDeps(match[2] ?? "") });
    }
    if (!grouped && dependencies) {
        groups.push({ framework: "", dependencies: readDeps(dependencies) });
    }

    return {
        id,
        version,
        description: text(metadata, "description"),
        license: license ? decodeXml(license.body).trim() || undefined : undefined,
        licenseUrl: text(metadata, "licenseUrl"),
        releaseNotes: text(metadata, "releaseNotes"),
        projectUrl: text(metadata, "projectUrl"),
        groups,
    };
}

/**
 * The folder name NuGet uses for a version in the global packages folder:
 * lower case, at least three parts, the fourth part only when it is not zero,
 * no build metadata.
 */
export function normalizedVersionFolder(version: string): string {
    const parsed = parseNuGetVersion(version);
    if (!parsed) {
        return version.trim().toLowerCase();
    }
    const [major, minor, patch, revision] = parsed.release;
    const release = revision !== 0 ? `${major}.${minor}.${patch}.${revision}` : `${major}.${minor}.${patch}`;
    return parsed.prerelease.length > 0 ? `${release}-${parsed.prerelease.join(".").toLowerCase()}` : release;
}

export function defaultGlobalPackagesPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
    return env.NUGET_PACKAGES || path.join(home, ".nuget", "packages");
}

export function nuspecPath(root: string, packageId: string, version: string): string {
    const id = packageId.toLowerCase();
    return path.join(root, id, normalizedVersionFolder(version), `${id}.nuspec`);
}

export async function readCachedNuspec(root: string, packageId: string, version: string): Promise<NuspecInfo | undefined> {
    try {
        return parseNuspec(await fs.readFile(nuspecPath(root, packageId, version), "utf8"));
    } catch {
        return undefined;
    }
}

export interface DependencyChanges {
    added: string[];
    removed: string[];
    changed: string[];
}

function dependencyMap(info: NuspecInfo | undefined): Map<string, { id: string; ranges: Set<string> }> {
    const map = new Map<string, { id: string; ranges: Set<string> }>();
    for (const group of info?.groups ?? []) {
        for (const dep of group.dependencies) {
            const key = dep.id.toLowerCase();
            const known = map.get(key) ?? { id: dep.id, ranges: new Set<string>() };
            if (dep.range) {
                known.ranges.add(dep.range);
            }
            map.set(key, known);
        }
    }
    return map;
}

function rangeText(ranges: Set<string>): string {
    return [...ranges].sort().join(" | ");
}

/**
 * Compares the dependencies of two versions across all target frameworks.
 */
export function diffDependencies(from: NuspecInfo | undefined, to: NuspecInfo): DependencyChanges {
    const before = dependencyMap(from);
    const after = dependencyMap(to);
    const result: DependencyChanges = { added: [], removed: [], changed: [] };
    for (const [key, dep] of after) {
        const old = before.get(key);
        if (!old) {
            result.added.push(dep.ranges.size > 0 ? `${dep.id} ${rangeText(dep.ranges)}` : dep.id);
        } else if (rangeText(old.ranges) !== rangeText(dep.ranges)) {
            result.changed.push(`${dep.id} ${rangeText(old.ranges) || "?"} → ${rangeText(dep.ranges) || "?"}`);
        }
    }
    for (const [key, dep] of before) {
        if (!after.has(key)) {
            result.removed.push(dep.id);
        }
    }
    for (const list of [result.added, result.removed, result.changed]) {
        list.sort((left, right) => left.localeCompare(right));
    }
    return result;
}

export function licenseText(info: NuspecInfo | undefined): string | undefined {
    if (!info) {
        return undefined;
    }
    return info.license || info.licenseUrl;
}

function shorten(value: string, limit: number): string {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

function listText(items: string[], limit = 6): string {
    const shown = items.slice(0, limit).join(", ");
    return items.length > limit ? l10n.t("{0} and {1} more", shown, items.length - limit) : shown;
}

export interface UpdateDetailsInput {
    packageId: string;
    toVersion: string;
    /** Metadata of the target version, when it was found. */
    to?: NuspecInfo;
    /** Metadata of the version the projects use now (the lowest one). */
    from?: NuspecInfo;
    fromVersion?: string;
    /** Where the target metadata came from. */
    source?: "cache" | "online";
    online: boolean;
}

/**
 * Lines for "What's in this update": license, release notes and dependency
 * changes. Says plainly when the data is not on this machine.
 */
export function describeUpdateDetails(input: UpdateDetailsInput): string[] {
    const lines: string[] = [];
    if (!input.to) {
        lines.push(input.online
            ? l10n.t("What's in {0} {1}: no package metadata was found in the local cache or on nuget.org.", input.packageId, input.toVersion)
            : l10n.t("What's in {0} {1}: the package is not in the local NuGet cache yet. Turn on packageHub.onlineLookups to read it from nuget.org.", input.packageId, input.toVersion));
        return lines;
    }
    lines.push(input.source === "online"
        ? l10n.t("What's in {0} (read from nuget.org):", input.toVersion)
        : l10n.t("What's in {0} (read from the local NuGet cache):", input.toVersion));

    const newLicense = licenseText(input.to);
    const oldLicense = licenseText(input.from);
    if (newLicense && oldLicense && newLicense !== oldLicense) {
        lines.push(l10n.t("• License changes: {0} → {1}", oldLicense, newLicense));
    } else if (newLicense) {
        lines.push(l10n.t("• License: {0}", newLicense));
    } else {
        lines.push(l10n.t("• License: not stated in the package."));
    }

    if (input.to.releaseNotes) {
        lines.push(l10n.t("• Release notes: {0}", shorten(input.to.releaseNotes, 280)));
    } else if (input.to.projectUrl) {
        lines.push(l10n.t("• Release notes: none in the package. Project: {0}", input.to.projectUrl));
    } else {
        lines.push(l10n.t("• Release notes: none in the package."));
    }

    if (!input.from && input.fromVersion) {
        lines.push(l10n.t("• Dependencies: {0} is not in the local cache, so changes cannot be compared.", input.fromVersion));
        return lines;
    }
    const changes = diffDependencies(input.from, input.to);
    if (!input.from) {
        const all = [...dependencyMap(input.to).values()].map((dep) => dep.id);
        lines.push(all.length > 0
            ? l10n.t("• Dependencies: {0}", listText(all))
            : l10n.t("• Dependencies: none."));
        return lines;
    }
    if (changes.added.length + changes.removed.length + changes.changed.length === 0) {
        lines.push(l10n.t("• Dependencies: no change."));
        return lines;
    }
    if (changes.added.length > 0) {
        lines.push(l10n.t("• New dependencies: {0}", listText(changes.added)));
    }
    if (changes.removed.length > 0) {
        lines.push(l10n.t("• Dropped dependencies: {0}", listText(changes.removed)));
    }
    if (changes.changed.length > 0) {
        lines.push(l10n.t("• Changed dependencies: {0}", listText(changes.changed)));
    }
    return lines;
}

/**
 * The lowest exact version in a list, used as the "from" side of a diff.
 */
export function lowestVersion(versions: (string | undefined)[]): string | undefined {
    let lowest: string | undefined;
    for (const version of versions) {
        if (!version || !parseNuGetVersion(version)) {
            continue;
        }
        if (!lowest || compareNuGetVersions(version, lowest) < 0) {
            lowest = version;
        }
    }
    return lowest;
}
