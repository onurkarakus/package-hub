/**
 * Feed health is built only from local data: the sources dotnet reports
 * (`dotnet nuget list source`), the output of the dotnet commands PackageHub
 * already ran, and the restore logs in project.assets.json. PackageHub does
 * not contact any feed to check it.
 */

export interface FeedSource {
    name: string;
    url: string;
    enabled: boolean;
}

export interface FeedFailure {
    code: string;
    message: string;
    url?: string;
    status?: number;
    at: number;
}

export interface FeedStatus extends FeedSource {
    failures: FeedFailure[];
    hints: string[];
}

export interface FeedHealthState {
    /** undefined until dotnet listed the sources. */
    sources?: FeedSource[];
    /** Why the sources could not be listed. */
    sourceError?: string;
    failures: FeedFailure[];
    /** Failures that name no source PackageHub knows. */
    unmatched: FeedFailure[];
    statuses: FeedStatus[];
    credentialProviders: string[];
}

/**
 * Reads `dotnet nuget list source --format detailed`:
 *
 *   Registered Sources:
 *     1.  nuget.org [Enabled]
 *         https://api.nuget.org/v3/index.json
 */
export function parseSourceList(text: string): FeedSource[] {
    const lines = text.split(/\r?\n/);
    const sources: FeedSource[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const head = /^\s*\d+\.\s+(.+?)\s+\[(Enabled|Disabled)\]\s*$/i.exec(lines[index]);
        if (!head) {
            continue;
        }
        let url = "";
        for (let next = index + 1; next < lines.length; next += 1) {
            const candidate = lines[next].trim();
            if (!candidate) {
                continue;
            }
            if (/^\d+\.\s/.test(candidate)) {
                break;
            }
            url = candidate;
            index = next;
            break;
        }
        sources.push({ name: head[1].trim(), url, enabled: head[2].toLowerCase() === "enabled" });
    }
    return sources;
}

const FEED_CODES = /\b(NU1301|NU1302|NU1801|NU1900|NU1905)\b/i;

function trimUrl(value: string): string {
    return value.replace(/[)\]'".,;:]+$/, "");
}

function statusIn(message: string): number | undefined {
    const match = /\b(401|403|404|407|429|500|502|503|504)\b/.exec(message)
        || /\b(Unauthorized|Forbidden|Not Found|Proxy Authentication Required)\b/i.exec(message);
    if (!match) {
        return undefined;
    }
    const named: Record<string, number> = {
        unauthorized: 401,
        forbidden: 403,
        "not found": 404,
        "proxy authentication required": 407,
    };
    const value = named[match[1].toLowerCase()] ?? Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * Finds feed failures in dotnet output: NU1301 (source unreachable), NU1302
 * (plain HTTP source), NU1801 (source warning), NU1900 (audit data could not
 * be read) and NU1905 (audit source has no data).
 */
export function parseFeedFailures(text: string, at = Date.now()): FeedFailure[] {
    const failures: FeedFailure[] = [];
    const seen = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const code = FEED_CODES.exec(line);
        if (!code) {
            continue;
        }
        const url = /(https?:\/\/[^\s'"]+|file:\/\/[^\s'"]+)/i.exec(line)?.[1];
        const message = line
            .replace(/^.*?:\s*(?:error|warning)\s+NU\d+:\s*/i, "")
            .replace(/\s+\[[^\]]+\]$/, "")
            .slice(0, 400);
        const failure: FeedFailure = {
            code: code[1].toUpperCase(),
            message,
            url: url ? trimUrl(url) : undefined,
            status: statusIn(line),
            at,
        };
        const key = `${failure.code}\n${failure.url ?? ""}\n${failure.message}`;
        if (!seen.has(key)) {
            seen.add(key);
            failures.push(failure);
        }
    }
    return failures;
}

/**
 * Reads feed failures from the `logs` array of project.assets.json.
 */
export function feedFailuresFromAssetsLogs(logs: unknown, at = Date.now()): FeedFailure[] {
    if (!Array.isArray(logs)) {
        return [];
    }
    const text = logs
        .filter((entry) => entry && typeof entry === "object")
        .map((entry: any) => `${String(entry.level || "")} ${String(entry.code || "")}: ${String(entry.message || "")}`)
        .join("\n");
    return parseFeedFailures(text, at);
}

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, "").toLowerCase();
}

function hostOf(url: string): string | undefined {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return undefined;
    }
}

export function failureMatchesSource(failure: FeedFailure, source: FeedSource): boolean {
    if (failure.url) {
        const a = normalizeUrl(failure.url);
        const b = normalizeUrl(source.url);
        if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
            return true;
        }
        const host = hostOf(failure.url);
        return !!host && host === hostOf(source.url) && !!host;
    }
    return new RegExp(`['"\\s]${escapeRegExp(source.name)}['"\\s.,]`, "i").test(` ${failure.message} `);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hints that explain a failing or unusual source. Text only. Nothing is
 * checked over the network.
 */
export function credentialHints(source: FeedSource, failures: FeedFailure[], credentialProviders: string[]): string[] {
    const hints: string[] = [];
    const url = source.url.toLowerCase();
    const authFailure = failures.some((failure) => failure.status === 401 || failure.status === 403);
    const azure = /pkgs\.dev\.azure\.com|\.pkgs\.visualstudio\.com/.test(url);
    const github = /nuget\.pkg\.github\.com/.test(url);

    if (azure && !credentialProviders.some((item) => /azure|microsoft/i.test(item))) {
        hints.push("Azure Artifacts feeds need the Azure Artifacts Credential Provider, or credentials in packageSourceCredentials.");
    } else if (azure && authFailure) {
        hints.push("The Azure Artifacts Credential Provider is installed. Run `dotnet restore --interactive` once to sign in.");
    }
    if (github) {
        hints.push("GitHub Packages needs a personal access token with read:packages in packageSourceCredentials.");
    }
    if (authFailure && !azure && !github) {
        hints.push("The feed rejected the request (401/403). Check packageSourceCredentials in NuGet.config or a credential provider.");
    }
    if (failures.some((failure) => failure.status === 407)) {
        hints.push("A proxy asked for credentials. Check the http_proxy settings in NuGet.config.");
    }
    if (url.startsWith("http://") || failures.some((failure) => failure.code === "NU1302")) {
        hints.push("This source uses plain HTTP. .NET 9 and newer block it unless allowInsecureConnections is set for it.");
    }
    if (failures.some((failure) => failure.code === "NU1900" || failure.code === "NU1905")) {
        hints.push("Vulnerability data could not be read from this source, so the audit may be incomplete.");
    }
    return hints;
}

export function buildFeedStatuses(
    sources: FeedSource[],
    failures: FeedFailure[],
    credentialProviders: string[]
): { statuses: FeedStatus[]; unmatched: FeedFailure[] } {
    const matched = new Set<FeedFailure>();
    const statuses = sources.map((source) => {
        const own = failures.filter((failure) => failureMatchesSource(failure, source));
        own.forEach((failure) => matched.add(failure));
        return { ...source, failures: own, hints: credentialHints(source, own, credentialProviders) };
    });
    return { statuses, unmatched: failures.filter((failure) => !matched.has(failure)) };
}

let state: FeedHealthState = { failures: [], unmatched: [], statuses: [], credentialProviders: [] };

export function getFeedHealth(): FeedHealthState {
    return state;
}

function rebuild(): void {
    const { statuses, unmatched } = buildFeedStatuses(state.sources ?? [], state.failures, state.credentialProviders);
    state = { ...state, statuses, unmatched };
}

export function setFeedSources(sources: FeedSource[] | undefined, sourceError?: string): void {
    state = { ...state, sources, sourceError };
    rebuild();
}

export function setCredentialProviders(names: string[]): void {
    state = { ...state, credentialProviders: names };
    rebuild();
}

/**
 * Starts a new scan: failures from the last scan are dropped.
 */
export function resetFeedFailures(): void {
    state = { ...state, failures: [] };
    rebuild();
}

export function recordFeedFailures(failures: FeedFailure[]): void {
    if (failures.length === 0) {
        return;
    }
    const merged = [...state.failures];
    for (const failure of failures) {
        const known = merged.some((item) =>
            item.code === failure.code && item.url === failure.url && item.message === failure.message
        );
        if (!known) {
            merged.push(failure);
        }
    }
    state = { ...state, failures: merged.slice(-50) };
    rebuild();
}

export function failingFeedCount(): number {
    return state.statuses.filter((status) => status.enabled && status.failures.length > 0).length
        + (state.unmatched.length > 0 ? 1 : 0);
}
