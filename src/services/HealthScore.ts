import { normalizeSeverity } from "../utils/nugetAudit";

export const SEVERITY_WEIGHTS = { critical: 15, high: 8, moderate: 4, low: 1 } as const;
export type ScoreSeverity = keyof typeof SEVERITY_WEIGHTS;

export const SCORE_CAPS = { vulnerable: 60, outdated: 20, deprecated: 12, feeds: 8 } as const;
export const OUTDATED_WEIGHT = 2;
export const DEPRECATED_WEIGHT = 4;
export const FEED_WEIGHT = 4;

export interface HealthScoreInput {
    /** The worst severity of each vulnerable package, one item per package id. */
    vulnerableSeverities: (string | undefined)[];
    /** Outdated packages that a project references directly. */
    outdatedDirect: number;
    /** Deprecated packages that a project references directly. */
    deprecatedDirect: number;
    /** Feeds that failed in the last scan or restore. */
    feedIssues: number;
}

export type HealthBand = "healthy" | "fair" | "attention" | "risk";

export interface HealthScore {
    score: number;
    band: HealthBand;
    /** Penalty per part, after the cap. */
    vulnerable: number;
    outdated: number;
    deprecated: number;
    feeds: number;
    /** The vulnerability penalty before the cap. */
    vulnerableRaw: number;
    severityCounts: Record<ScoreSeverity, number>;
    counts: { outdated: number; deprecated: number; feeds: number };
}

function count(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The score shown on the dashboard:
 *
 *   score = max(0, 100 - V - O - D - F)
 *
 * V adds the worst advisory of each vulnerable package (critical 15, high 8,
 * moderate 4, low 1) and stops at 60. O is 2 per outdated direct package, up
 * to 20. D is 4 per deprecated direct package, up to 12. F is 4 per failing
 * feed, up to 8. The caps keep one kind of problem from hiding the others.
 * A vulnerable package without a known severity counts as low.
 */
export function computeHealthScore(input: HealthScoreInput): HealthScore {
    const severityCounts: Record<ScoreSeverity, number> = { critical: 0, high: 0, moderate: 0, low: 0 };
    let vulnerableRaw = 0;
    for (const raw of input.vulnerableSeverities) {
        const severity = (normalizeSeverity(raw)?.toLowerCase() ?? "low") as ScoreSeverity;
        severityCounts[severity] += 1;
        vulnerableRaw += SEVERITY_WEIGHTS[severity];
    }

    const outdatedCount = count(input.outdatedDirect);
    const deprecatedCount = count(input.deprecatedDirect);
    const feedCount = count(input.feedIssues);

    const vulnerable = Math.min(SCORE_CAPS.vulnerable, vulnerableRaw);
    const outdated = Math.min(SCORE_CAPS.outdated, outdatedCount * OUTDATED_WEIGHT);
    const deprecated = Math.min(SCORE_CAPS.deprecated, deprecatedCount * DEPRECATED_WEIGHT);
    const feeds = Math.min(SCORE_CAPS.feeds, feedCount * FEED_WEIGHT);
    const score = Math.max(0, 100 - vulnerable - outdated - deprecated - feeds);

    return {
        score,
        band: healthBand(score),
        vulnerable,
        outdated,
        deprecated,
        feeds,
        vulnerableRaw,
        severityCounts,
        counts: { outdated: outdatedCount, deprecated: deprecatedCount, feeds: feedCount },
    };
}

export function healthBand(score: number): HealthBand {
    if (score >= 80) {
        return "healthy";
    }
    if (score >= 60) {
        return "fair";
    }
    if (score >= 40) {
        return "attention";
    }
    return "risk";
}
