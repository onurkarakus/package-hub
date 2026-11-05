import * as assert from "assert";
import { computeHealthScore, healthBand } from "../services/HealthScore";

suite("Health score", () => {
    test("a clean workspace scores 100", () => {
        const score = computeHealthScore({ vulnerableSeverities: [], outdatedDirect: 0, deprecatedDirect: 0, feedIssues: 0 });
        assert.strictEqual(score.score, 100);
        assert.strictEqual(score.band, "healthy");
    });

    test("each part uses its weight", () => {
        const score = computeHealthScore({
            vulnerableSeverities: ["Critical", "High", "Moderate", "Low"],
            outdatedDirect: 3,
            deprecatedDirect: 1,
            feedIssues: 1,
        });
        assert.strictEqual(score.vulnerableRaw, 15 + 8 + 4 + 1);
        assert.strictEqual(score.vulnerable, 28);
        assert.strictEqual(score.outdated, 6);
        assert.strictEqual(score.deprecated, 4);
        assert.strictEqual(score.feeds, 4);
        assert.strictEqual(score.score, 100 - 28 - 6 - 4 - 4);
        assert.deepStrictEqual(score.severityCounts, { critical: 1, high: 1, moderate: 1, low: 1 });
    });

    test("every part stops at its cap", () => {
        const score = computeHealthScore({
            vulnerableSeverities: Array(10).fill("critical"),
            outdatedDirect: 50,
            deprecatedDirect: 9,
            feedIssues: 7,
        });
        assert.strictEqual(score.vulnerableRaw, 150);
        assert.strictEqual(score.vulnerable, 60);
        assert.strictEqual(score.outdated, 20);
        assert.strictEqual(score.deprecated, 12);
        assert.strictEqual(score.feeds, 8);
        assert.strictEqual(score.score, 0);
        assert.strictEqual(score.band, "risk");
    });

    test("the contoso-shop sample: 7 high, 2 moderate, 7 outdated, 3 deprecated", () => {
        const score = computeHealthScore({
            vulnerableSeverities: [...Array(7).fill("High"), "Moderate", "Moderate"],
            outdatedDirect: 7,
            deprecatedDirect: 3,
            feedIssues: 0,
        });
        assert.strictEqual(score.vulnerableRaw, 64);
        assert.strictEqual(score.vulnerable, 60);
        assert.strictEqual(score.score, 14);
    });

    test("an unknown severity counts as low and bad counts are ignored", () => {
        const score = computeHealthScore({ vulnerableSeverities: [undefined, "weird"], outdatedDirect: -3, deprecatedDirect: Number.NaN, feedIssues: 1.7 });
        assert.strictEqual(score.vulnerable, 2);
        assert.strictEqual(score.severityCounts.low, 2);
        assert.strictEqual(score.outdated, 0);
        assert.strictEqual(score.deprecated, 0);
        assert.strictEqual(score.feeds, 4);
    });

    test("bands", () => {
        assert.strictEqual(healthBand(80), "healthy");
        assert.strictEqual(healthBand(79), "fair");
        assert.strictEqual(healthBand(60), "fair");
        assert.strictEqual(healthBand(59), "attention");
        assert.strictEqual(healthBand(40), "attention");
        assert.strictEqual(healthBand(39), "risk");
    });
});
