import { PackageInfo } from "../models/PackageInfo";
import { FeedHealthState } from "../services/FeedHealth";
import { computeHealthScore, HealthScore, ScoreSeverity } from "../services/HealthScore";
import { buildUpdateSummary } from "../services/UpdateSummary";
import { compareNuGetVersions, isNewerVersion, normalizeSeverity, severityRank, versionChange } from "../utils/nugetAudit";

/**
 * Everything the dashboard page draws, as plain JSON. It is built from the
 * last scan and the local advisory data only: building it runs no dotnet
 * command and makes no network request.
 */

export type AdvisoryVerdict = "open" | "closed" | "unknown";
export type DashboardChange = "patch" | "minor" | "major" | "replace" | "none";

export interface DashboardAdvisory {
    id: string;
    url: string;
    severity: ScoreSeverity | "unknown";
    /** Whether the suggested version is still inside the advisory range. */
    verdict: AdvisoryVerdict;
}

export interface DashboardWhyNode {
    name: string;
    version?: string;
    kind: "project" | "package";
}

export interface DashboardPackage {
    id: string;
    current: string;
    suggested?: string;
    change: DashboardChange;
    latest?: string;
    highestPatch?: string;
    kind: "direct" | "transitive";
    directIn: string[];
    transitiveIn: string[];
    severity: ScoreSeverity | "none";
    advisories: DashboardAdvisory[];
    outdated: boolean;
    deprecated?: string;
    alternative?: string;
    /** The direct package or project that brings a transitive package in. */
    parents: string[];
    why: DashboardWhyNode[][];
    note?: { tone: "ok" | "warn"; text: string };
}

export interface DashboardProject {
    name: string;
    direct: number;
    vulnerable: number;
    outdated: number;
    deprecated: number;
}

export type DashboardActionKind = "patch" | "update" | "pin" | "replace" | "minor";

export interface DashboardUpdate {
    packageId: string;
    from: string;
    to: string;
    change: DashboardChange;
}

export interface DashboardAction {
    id: string;
    kind: DashboardActionKind;
    title: string;
    badge: DashboardChange;
    description: string;
    updates: DashboardUpdate[];
    /** Advisories the action closes, by the local advisory ranges. */
    closes: number;
    projects: string[];
    files: string[];
    score?: { from: number; to: number };
    warning?: string;
    button: string;
    /** The local update summary shown by Preview. */
    preview: { heading: string; lines: string[] };
}

export interface DashboardFeed {
    name: string;
    url: string;
    enabled: boolean;
    failures: { code: string; message: string }[];
    hints: string[];
}

export interface DashboardFeeds {
    listed: boolean;
    sourceError?: string;
    items: DashboardFeed[];
    issues: number;
    unmatched: { code: string; message: string }[];
    credentialProviders: string[];
}

export interface DashboardState {
    hasScan: boolean;
    scannedAt?: string;
    cpm: boolean;
    centralFiles: string[];
    online: boolean;
    advisorySource?: "local" | "online";
    score: HealthScore;
    advisoryCount: number;
    packages: DashboardPackage[];
    projects: DashboardProject[];
    actions: DashboardAction[];
    feeds: DashboardFeeds;
    conflicts: number;
    ignored: number;
    notices: string[];
}

export interface DashboardInput {
    vulnerable: PackageInfo[];
    outdated: PackageInfo[];
    deprecated: PackageInfo[];
    installed: PackageInfo[];
    scannedAt?: Date;
    cpm: boolean;
    /** Workspace-relative paths of Directory.Packages.props files. */
    centralFiles: string[];
    feeds: FeedHealthState;
    online: boolean;
    advisorySource?: "local" | "online";
    conflicts: number;
    ignored: number;
    auditDataGap: boolean;
    unreadableProjects: string[];
    verdict(packageId: string, advisoryUrl: string, version: string): AdvisoryVerdict;
    firstFixed(packageId: string, advisoryUrl: string, current: string): string | undefined;
    /** Turns a project file path into the text shown on the page. */
    relativePath?(filePath: string): string;
}

const MAX_SINGLE_ACTIONS = 3;

export function advisoryId(url: string): string {
    const match = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
    if (match) {
        return match[0];
    }
    const tail = url.replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
    return tail || url;
}

function key(value: string): string {
    return value.toLowerCase();
}

function uniq(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (value && !seen.has(key(value))) {
            seen.add(key(value));
            result.push(value);
        }
    }
    return result;
}

function scoreSeverity(value: string | undefined): ScoreSeverity | undefined {
    return normalizeSeverity(value)?.toLowerCase() as ScoreSeverity | undefined;
}

function toChange(from: string, to: string | undefined): DashboardChange {
    if (!to) {
        return "none";
    }
    const change = versionChange(from, to);
    if (change === "major" || change === "minor" || change === "patch") {
        return change;
    }
    return change === "revision" || change === "prerelease" ? "patch" : "none";
}

function newer(candidate: string | undefined, current: string): candidate is string {
    if (!candidate || !current) {
        return false;
    }
    try {
        return isNewerVersion(candidate, current);
    } catch {
        return false;
    }
}

function basename(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

interface Merged {
    id: string;
    vulnerable?: PackageInfo;
    outdated?: PackageInfo;
    deprecated?: PackageInfo;
}

function mergeById(input: DashboardInput): Merged[] {
    const byId = new Map<string, Merged>();
    const add = (list: PackageInfo[], slot: "vulnerable" | "outdated" | "deprecated") => {
        for (const pkg of list) {
            if (!pkg?.id) {
                continue;
            }
            const item = byId.get(key(pkg.id)) ?? { id: pkg.id };
            if (!item[slot]) {
                item[slot] = pkg;
            }
            byId.set(key(pkg.id), item);
        }
    };
    add(input.vulnerable, "vulnerable");
    add(input.outdated, "outdated");
    add(input.deprecated, "deprecated");
    return [...byId.values()];
}

function directNames(pkg: PackageInfo): string[] {
    if (pkg.directProjects) {
        return pkg.directProjects;
    }
    const transitive = new Set((pkg.transitiveProjects || []).map(key));
    return pkg.isTransitive ? [] : (pkg.projects || []).filter((name) => !transitive.has(key(name)));
}

function advisoriesOf(pkg: PackageInfo): { url: string; severity: ScoreSeverity | "unknown" }[] {
    const urls = uniq(pkg.advisoryUrls?.length ? pkg.advisoryUrls : pkg.advisoryUrl ? [pkg.advisoryUrl] : []);
    const fallback: ScoreSeverity | "unknown" = scoreSeverity(pkg.severity) ?? "unknown";
    return urls
        .map((url) => ({ url, severity: scoreSeverity(pkg.advisorySeverities?.[url]) ?? fallback }) as { url: string; severity: ScoreSeverity | "unknown" })
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/**
 * The lowest version that closes every advisory of the package, by the local
 * ranges: the highest patch when it is enough, then the highest first-fixed
 * version, then the latest version.
 */
function fixingVersion(
    input: DashboardInput,
    pkg: PackageInfo,
    urls: string[],
    highestPatch: string | undefined,
    latest: string | undefined
): string | undefined {
    const current = pkg.version;
    const closesAll = (version: string) => urls.every((url) => input.verdict(pkg.id, url, version) === "closed");
    if (newer(highestPatch, current) && closesAll(highestPatch)) {
        return highestPatch;
    }
    const fixes = urls.map((url) => input.firstFixed(pkg.id, url, current));
    if (fixes.length > 0 && fixes.every((value): value is string => !!value)) {
        const highest = [...fixes].sort(compareNuGetVersions).pop()!;
        if (newer(highest, current) && closesAll(highest)) {
            return highest;
        }
    }
    if (newer(latest, current) && closesAll(latest)) {
        return latest;
    }
    return undefined;
}

function whyPaths(pkg: PackageInfo, directIn: string[]): DashboardWhyNode[][] {
    const paths: DashboardWhyNode[][] = [];
    const seen = new Set<string>();
    const push = (path: DashboardWhyNode[]) => {
        const id = path.map((node) => `${node.kind}:${node.name}`).join(">").toLowerCase();
        if (!seen.has(id)) {
            seen.add(id);
            paths.push(path);
        }
    };
    const target: DashboardWhyNode = { name: pkg.id, version: pkg.version, kind: "package" };
    for (const project of directIn) {
        push([{ name: project, kind: "project" }, target]);
    }
    for (const origin of pkg.transitiveOrigins || []) {
        const path: DashboardWhyNode[] = [{ name: origin.project, kind: "project" }];
        if (origin.broughtBy) {
            path.push({ name: origin.broughtBy, kind: origin.broughtByKind === "project" ? "project" : "package" });
        }
        path.push(target);
        push(path);
    }
    if (paths.length === 0) {
        for (const project of pkg.transitiveProjects || []) {
            push([{ name: project, kind: "project" }, target]);
        }
    }
    return paths;
}

function buildPackage(input: DashboardInput, item: Merged): DashboardPackage {
    const lead = (item.vulnerable ?? item.outdated ?? item.deprecated)!;
    const all = [item.vulnerable, item.outdated, item.deprecated].filter((pkg): pkg is PackageInfo => !!pkg);
    const current = lead.version;
    const directIn = uniq(all.flatMap(directNames));
    const projects = uniq(all.flatMap((pkg) => pkg.projects || []));
    const transitiveIn = projects.filter((name) => !directIn.some((direct) => key(direct) === key(name)));
    const latest = all.map((pkg) => pkg.latestVersion).find((value) => newer(value, current));
    const highestPatch = all.map((pkg) => pkg.highestPatch).find((value) => newer(value, current));
    const kind = directIn.length > 0 ? "direct" : "transitive";
    const rawAdvisories = item.vulnerable ? advisoriesOf(item.vulnerable) : [];
    const deprecatedEntry = item.deprecated?.entries?.find((entry) => entry.deprecationReasons?.length || entry.alternativePackage);
    const deprecated = item.deprecated
        ? (deprecatedEntry?.deprecationReasons?.join(", ") || "Deprecated")
        : undefined;
    const alternative = deprecatedEntry?.alternativePackage;
    const parents = uniq((lead.transitiveOrigins || item.vulnerable?.transitiveOrigins || [])
        .map((origin) => origin.broughtBy || "")
        .filter(Boolean));

    let suggested: string | undefined;
    if (rawAdvisories.length > 0) {
        suggested = fixingVersion(input, lead, rawAdvisories.map((advisory) => advisory.url), highestPatch, latest);
    } else if (item.outdated) {
        suggested = highestPatch ?? latest;
    }

    let change = toChange(current, suggested);
    if (!suggested && alternative) {
        change = "replace";
    }

    const advisories: DashboardAdvisory[] = rawAdvisories.map((advisory) => ({
        id: advisoryId(advisory.url),
        url: advisory.url,
        severity: advisory.severity,
        verdict: suggested ? input.verdict(lead.id, advisory.url, suggested) : "unknown",
    }));

    const worst = advisories.reduce<ScoreSeverity | "none">((acc, advisory) => {
        if (advisory.severity === "unknown") {
            return acc === "none" ? "low" : acc;
        }
        return severityRank(advisory.severity) > severityRank(acc === "none" ? undefined : acc) ? advisory.severity : acc;
    }, item.vulnerable ? (scoreSeverity(item.vulnerable.severity) ?? "none") : "none");

    return {
        id: lead.id,
        current,
        suggested,
        change,
        latest,
        highestPatch,
        kind,
        directIn,
        transitiveIn,
        severity: item.vulnerable && worst === "none" ? "low" : worst,
        advisories,
        outdated: !!item.outdated,
        deprecated,
        alternative,
        parents,
        why: whyPaths(lead, directIn),
        note: packageNote(input, lead.id, kind, suggested, highestPatch, advisories, transitiveIn, parents, deprecated, alternative),
    };
}

function packageNote(
    input: DashboardInput,
    id: string,
    kind: "direct" | "transitive",
    suggested: string | undefined,
    highestPatch: string | undefined,
    advisories: DashboardAdvisory[],
    transitiveIn: string[],
    parents: string[],
    deprecated: string | undefined,
    alternative: string | undefined
): DashboardPackage["note"] {
    if (advisories.length > 0) {
        if (!suggested) {
            return {
                tone: "warn",
                text: input.advisorySource
                    ? "The local advisory data names no version that closes every advisory."
                    : "No advisory ranges are loaded. Restore once with NuGetAudit on, or turn on packageHub.onlineLookups.",
            };
        }
        const count = advisories.length === 1 ? "the advisory" : `all ${advisories.length} advisories`;
        if (kind === "transitive") {
            const from = parents.length > 0 ? ` It comes in through ${parents.join(", ")}; updating that may move it too.` : "";
            return {
                tone: "warn",
                text: `${suggested} closes ${count}. ${id} is not referenced directly, so the update pins it in ${transitiveIn.join(", ")}.${from}`,
            };
        }
        if (suggested === highestPatch) {
            return { tone: "ok", text: `${suggested} is the highest patch and closes ${count}.` };
        }
        const patchText = highestPatch ? ` The highest patch, ${highestPatch}, does not.` : "";
        return { tone: "warn", text: `${suggested} is the first version that closes ${count}.${patchText} Review the changes before you update.` };
    }
    if (deprecated) {
        return {
            tone: "warn",
            text: alternative
                ? `Deprecated (${deprecated}). NuGet lists ${alternative} as the alternative.`
                : `Deprecated (${deprecated}). NuGet lists no alternative.`,
        };
    }
    return undefined;
}

function buildProjects(input: DashboardInput, packages: DashboardPackage[]): DashboardProject[] {
    const names = uniq([
        ...input.installed.flatMap((pkg) => pkg.projects || []),
        ...packages.flatMap((pkg) => [...pkg.directIn, ...pkg.transitiveIn]),
    ]).sort((a, b) => a.localeCompare(b));
    const has = (list: string[], name: string) => list.some((item) => key(item) === key(name));
    return names.map((name) => ({
        name,
        direct: input.installed.filter((pkg) => has(directNames(pkg), name)).length,
        vulnerable: packages.filter((pkg) => pkg.advisories.length > 0 && (has(pkg.directIn, name) || has(pkg.transitiveIn, name))).length,
        outdated: packages.filter((pkg) => pkg.outdated && has(pkg.directIn, name)).length,
        deprecated: packages.filter((pkg) => pkg.deprecated && (has(pkg.directIn, name) || has(pkg.transitiveIn, name))).length,
    }));
}

function scoreOf(packages: DashboardPackage[], feedIssues: number): HealthScore {
    return computeHealthScore({
        vulnerableSeverities: packages.filter((pkg) => pkg.advisories.length > 0).map((pkg) => pkg.severity),
        outdatedDirect: packages.filter((pkg) => pkg.outdated && pkg.kind === "direct").length,
        deprecatedDirect: packages.filter((pkg) => pkg.deprecated && pkg.kind === "direct").length,
        feedIssues,
    });
}

function filesFor(input: DashboardInput, pkgs: PackageInfo[]): string[] {
    if (input.cpm && input.centralFiles.length > 0) {
        return input.centralFiles;
    }
    const relative = input.relativePath ?? basename;
    return uniq(pkgs.flatMap((pkg) => Object.entries(pkg.projectPaths || {})
        .filter(([name]) => directNames(pkg).some((direct) => key(direct) === key(name)))
        .map(([, filePath]) => relative(filePath))));
}

function findInfo(input: DashboardInput, id: string): PackageInfo[] {
    return [...input.vulnerable, ...input.outdated, ...input.deprecated].filter((pkg) => key(pkg.id) === key(id));
}

function closedCount(pkg: DashboardPackage, version: string, input: DashboardInput): number {
    return pkg.advisories.filter((advisory) => input.verdict(pkg.id, advisory.url, version) === "closed").length;
}

function summaryFor(input: DashboardInput, pkg: DashboardPackage, version: string): { heading: string; lines: string[] } {
    const summary = buildUpdateSummary({
        packageId: pkg.id,
        targetVersion: version,
        projects: [
            ...pkg.directIn.map((name) => ({ name, fromVersion: pkg.current, relation: "direct" as const })),
            ...(pkg.kind === "transitive" ? pkg.transitiveIn.map((name) => ({ name, fromVersion: pkg.current, relation: "transitive" as const })) : []),
        ],
        advisories: pkg.advisories.map((advisory) => ({
            url: advisory.url,
            label: advisory.id,
            verdict: input.verdict(pkg.id, advisory.url, version),
        })),
        centralFiles: filesFor(input, findInfo(input, pkg.id)),
        usesCentralPackageManagement: input.cpm,
    });
    return { heading: summary.heading, lines: summary.lines };
}

function buildActions(input: DashboardInput, packages: DashboardPackage[], score: HealthScore, feedIssues: number): DashboardAction[] {
    const actions: DashboardAction[] = [];
    const direct = packages.filter((pkg) => pkg.kind === "direct");

    // 1. Every direct package with a newer patch. This is what "Highest patch" writes.
    const patchable = direct.filter((pkg) => pkg.highestPatch && (pkg.outdated || pkg.advisories.length > 0));
    if (patchable.length > 0) {
        const closes = patchable.reduce((sum, pkg) => sum + closedCount(pkg, pkg.highestPatch!, input), 0);
        const projected = packages.map((pkg) => {
            if (!patchable.includes(pkg)) {
                return pkg;
            }
            const fixed = pkg.advisories.length > 0 && closedCount(pkg, pkg.highestPatch!, input) === pkg.advisories.length;
            const reachesLatest = !pkg.latest || pkg.latest === pkg.highestPatch;
            return { ...pkg, advisories: fixed ? [] : pkg.advisories, outdated: pkg.outdated && !reachesLatest };
        });
        const after = scoreOf(projected, feedIssues).score;
        const lines = patchable.map((pkg) => {
            const closed = pkg.advisories
                .filter((advisory) => input.verdict(pkg.id, advisory.url, pkg.highestPatch!) === "closed")
                .map((advisory) => advisory.id);
            const open = pkg.advisories.length - closed.length;
            const tail = closed.length > 0 ? ` · closes ${closed.join(", ")}` : "";
            const stays = open > 0 ? ` · ${open} stay${open === 1 ? "s" : ""} open` : "";
            return `${pkg.id} ${pkg.current} → ${pkg.highestPatch}${tail}${stays}`;
        });
        const files = filesFor(input, patchable.flatMap((pkg) => findInfo(input, pkg.id)));
        lines.push(files.length > 0 ? `Edits ${files.join(", ")}.` : "dotnet add package writes the versions to the project files.");
        lines.push("dotnet lists the highest patches again before anything is written.");
        actions.push({
            id: "patch",
            kind: "patch",
            title: `Apply ${patchable.length} patch update${patchable.length === 1 ? "" : "s"}`,
            badge: "patch",
            description: closes > 0
                ? "Patch versions in the same minor. They close advisories without a major bump."
                : "Patch versions in the same minor. Low risk.",
            updates: patchable.map((pkg) => ({ packageId: pkg.id, from: pkg.current, to: pkg.highestPatch!, change: "patch" })),
            closes,
            projects: uniq(patchable.flatMap((pkg) => pkg.directIn)),
            files,
            score: after > score.score ? { from: score.score, to: after } : undefined,
            button: `Apply ${patchable.length} update${patchable.length === 1 ? "" : "s"}`,
            preview: { heading: `Highest patch: ${patchable.length} update${patchable.length === 1 ? "" : "s"}`, lines },
        });
    }

    // 2. Vulnerable direct packages that need more than a patch.
    const bigger = direct
        .filter((pkg) => pkg.advisories.length > 0 && pkg.suggested && pkg.suggested !== pkg.highestPatch)
        .sort(bySeverity)
        .slice(0, MAX_SINGLE_ACTIONS);
    for (const pkg of bigger) {
        const version = pkg.suggested!;
        const closes = closedCount(pkg, version, input);
        actions.push({
            id: `update:${pkg.id}`,
            kind: "update",
            title: `${pkg.id} to ${version}`,
            badge: pkg.change,
            description: pkg.highestPatch
                ? `No patch closes ${pkg.advisories.length === 1 ? "the advisory" : "these advisories"}; ${pkg.highestPatch} is still affected.`
                : `The first version that closes ${pkg.advisories.length === 1 ? "the advisory" : "every advisory"}.`,
            updates: [{ packageId: pkg.id, from: pkg.current, to: version, change: pkg.change }],
            closes,
            projects: pkg.directIn,
            files: filesFor(input, findInfo(input, pkg.id)),
            button: "Review & apply",
            preview: summaryFor(input, pkg, version),
        });
    }

    // 3. Vulnerable transitive packages: pin the fixed version.
    const pins = packages
        .filter((pkg) => pkg.kind === "transitive" && pkg.advisories.length > 0 && pkg.suggested)
        .sort(bySeverity)
        .slice(0, MAX_SINGLE_ACTIONS);
    for (const pkg of pins) {
        const version = pkg.suggested!;
        actions.push({
            id: `pin:${pkg.id}`,
            kind: "pin",
            title: `Pin ${pkg.id} to ${version}`,
            badge: pkg.change,
            description: pkg.parents.length > 0
                ? `Transitive through ${pkg.parents.join(", ")}. A direct reference pins the fixed version.`
                : "Transitive. A direct reference pins the fixed version.",
            updates: [{ packageId: pkg.id, from: pkg.current, to: version, change: pkg.change }],
            closes: closedCount(pkg, version, input),
            projects: pkg.transitiveIn,
            files: input.cpm && input.centralFiles.length > 0 ? input.centralFiles : [],
            button: "Review & pin",
            preview: summaryFor(input, pkg, version),
        });
    }

    // 4. Deprecated direct packages with an alternative.
    for (const pkg of direct.filter((item) => item.deprecated && item.alternative && item.change === "replace")) {
        actions.push({
            id: `replace:${pkg.id}`,
            kind: "replace",
            title: `Replace ${pkg.id}`,
            badge: "replace",
            description: `Deprecated (${pkg.deprecated}). NuGet lists ${pkg.alternative} as the alternative.`,
            updates: [{ packageId: pkg.id, from: pkg.current, to: pkg.alternative!, change: "replace" }],
            closes: 0,
            projects: pkg.directIn,
            files: filesFor(input, findInfo(input, pkg.id)),
            warning: "Code changes needed",
            button: "Show dependency graph",
            preview: {
                heading: `Replace ${pkg.id} ${pkg.current}`,
                lines: [
                    `${pkg.id} is deprecated (${pkg.deprecated}).`,
                    `NuGet lists ${pkg.alternative} as the alternative. It is a different package, so the code that uses it has to change.`,
                    `Referenced directly in: ${pkg.directIn.join(", ")}.`,
                    "PackageHub does not make this change for you.",
                ],
            },
        });
    }

    // 5. Outdated direct packages the patch step does not bring to the latest version.
    const behind = direct.filter((pkg) => pkg.outdated && pkg.latest && pkg.latest !== pkg.highestPatch);
    if (behind.length > 0) {
        actions.push({
            id: "minor",
            kind: "minor",
            title: "Review highest-minor updates",
            badge: "minor",
            description: `${behind.length} direct package${behind.length === 1 ? " is" : "s are"} behind the latest version. Minor updates stay in the same major.`,
            updates: [],
            closes: 0,
            projects: uniq(behind.flatMap((pkg) => pkg.directIn)),
            files: filesFor(input, behind.flatMap((pkg) => findInfo(input, pkg.id))),
            button: "List minor updates",
            preview: {
                heading: "Highest minor",
                lines: [
                    ...behind.map((pkg) => `${pkg.id} ${pkg.current} · latest ${pkg.latest}`),
                    "dotnet lists the highest minor of each package, and you confirm before anything is written. Major versions and prereleases are not written.",
                ],
            },
        });
    }

    return actions;
}

function bySeverity(a: DashboardPackage, b: DashboardPackage): number {
    const rank = (pkg: DashboardPackage) => (pkg.severity === "none" ? 0 : severityRank(pkg.severity));
    return rank(b) - rank(a)
        || (b.directIn.length + b.transitiveIn.length) - (a.directIn.length + a.transitiveIn.length)
        || a.id.localeCompare(b.id);
}

function buildFeeds(state: FeedHealthState): DashboardFeeds {
    const items = state.statuses.map((status) => ({
        name: status.name,
        url: status.url,
        enabled: status.enabled,
        failures: status.failures.map((failure) => ({ code: failure.code, message: failure.message })),
        hints: [...status.hints],
    }));
    return {
        listed: state.sources !== undefined,
        sourceError: state.sourceError,
        items,
        issues: items.filter((item) => item.enabled && item.failures.length > 0).length,
        unmatched: state.unmatched.map((failure) => ({ code: failure.code, message: failure.message })),
        credentialProviders: [...state.credentialProviders],
    };
}

export function buildDashboardState(input: DashboardInput): DashboardState {
    const packages = mergeById(input).map((item) => buildPackage(input, item)).sort(bySeverity);
    const feeds = buildFeeds(input.feeds);
    const score = scoreOf(packages, feeds.issues);
    const advisoryCount = new Set(packages.flatMap((pkg) => pkg.advisories.map((advisory) => key(advisory.id)))).size;

    const notices: string[] = [];
    if (input.auditDataGap) {
        notices.push("The audit source did not return vulnerability data. Vulnerable counts may be low.");
    }
    if (input.unreadableProjects.length > 0) {
        notices.push(`Not checked: ${input.unreadableProjects.join(", ")}.`);
    }

    return {
        hasScan: !!input.scannedAt,
        scannedAt: input.scannedAt?.toISOString(),
        cpm: input.cpm,
        centralFiles: input.centralFiles,
        online: input.online,
        advisorySource: input.advisorySource,
        score,
        advisoryCount,
        packages,
        projects: buildProjects(input, packages),
        actions: buildActions(input, packages, score, feeds.issues),
        feeds,
        conflicts: input.conflicts,
        ignored: input.ignored,
        notices,
    };
}

export function findAction(state: DashboardState | undefined, actionId: string): DashboardAction | undefined {
    return state?.actions.find((action) => action.id === actionId);
}
