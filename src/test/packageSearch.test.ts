import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    isValidSearchQuery,
    matchPackageIds,
    mergeHits,
    newestVersion,
    parseExactVersions,
    parseSearchResults,
    searchLocalPackages,
    sortVersionsDescending,
} from "../services/PackageSearch";

suite("Package search", () => {
    test("accepts only plain search text", () => {
        assert.strictEqual(isValidSearchQuery("Serilog"), true);
        assert.strictEqual(isValidSearchQuery("Microsoft.Extensions.Logging"), true);
        assert.strictEqual(isValidSearchQuery("json parser"), true);
        assert.strictEqual(isValidSearchQuery("--source http://evil"), false);
        assert.strictEqual(isValidSearchQuery("a;rm -rf /"), false);
        assert.strictEqual(isValidSearchQuery(""), false);
        assert.strictEqual(isValidSearchQuery(42), false);
    });

    test("sorts versions and picks the newest stable", () => {
        assert.deepStrictEqual(sortVersionsDescending(["1.0.0", "1.10.0", "1.2.0", "2.0.0-beta"]), ["2.0.0-beta", "1.10.0", "1.2.0", "1.0.0"]);
        assert.strictEqual(newestVersion(["1.0.0", "2.0.0-beta", "1.5.0"]), "1.5.0");
        assert.strictEqual(newestVersion(["1.0.0", "2.0.0-beta"], true), "1.0.0");
        assert.strictEqual(newestVersion(["2.0.0-beta", "2.0.0-alpha"], true), "2.0.0-beta");
        assert.strictEqual(newestVersion(["2.0.0-beta"]), undefined);
    });

    test("ranks exact, prefix, segment and substring matches", () => {
        const ids = ["Newtonsoft.Json.Bson", "Newtonsoft.Json", "System.Text.Json", "Jsonize", "Serilog"];
        assert.deepStrictEqual(matchPackageIds(ids, "newtonsoft.json"), ["Newtonsoft.Json", "Newtonsoft.Json.Bson"]);
        const json = matchPackageIds(ids, "json");
        assert.strictEqual(json[0], "Jsonize");
        assert.strictEqual(json.length, 4);
        assert.ok(!json.includes("Serilog"));
        assert.deepStrictEqual(matchPackageIds(ids, "zzz"), []);
    });

    test("reads dotnet package search output", () => {
        const json = JSON.stringify({
            version: 2,
            problems: [],
            searchResult: [
                { sourceName: "nuget.org", packages: [{ id: "Serilog", latestVersion: "4.0.0", description: "Logging", totalDownloads: 10 }] },
                { sourceName: "internal", problems: [{ text: "401 Unauthorized" }], packages: [{ id: "serilog", latestVersion: "4.1.0" }] },
            ],
        });
        const result = parseSearchResults(json);
        assert.strictEqual(result.hits.length, 1);
        assert.deepStrictEqual(result.hits[0].versions, ["4.1.0", "4.0.0"]);
        assert.strictEqual(result.hits[0].sourceName, "nuget.org");
        assert.deepStrictEqual(result.problems, ["internal: 401 Unauthorized"]);
        const exact = JSON.stringify({ searchResult: [{ packages: [{ id: "Serilog", version: "3.0.0" }, { id: "Serilog", version: "3.1.0" }, { id: "Other", version: "9.0.0" }] }] });
        assert.deepStrictEqual(parseExactVersions(exact, "serilog"), ["3.1.0", "3.0.0"]);
    });

    test("merges local and feed hits", () => {
        const merged = mergeHits(
            [{ id: "Serilog", versions: ["3.0.0"], source: "local", description: "local text" }],
            [{ id: "serilog", versions: ["4.0.0"], latestVersion: "4.0.0", source: "feed", sourceName: "nuget.org" }]
        );
        assert.strictEqual(merged.length, 1);
        assert.deepStrictEqual(merged[0].versions, ["4.0.0", "3.0.0"]);
        assert.strictEqual(merged[0].source, "local");
        assert.strictEqual(merged[0].description, "local text");
    });

    test("searches the local NuGet cache without the network", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "ph-search-"));
        try {
            for (const version of ["1.0.0", "1.1.0"]) {
                const dir = path.join(root, "contoso.widgets", version);
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, "contoso.widgets.nuspec"),
                    `<package><metadata><id>Contoso.Widgets</id><version>${version}</version><description>Widgets</description></metadata></package>`);
            }
            // A folder without a nuspec is a broken extract and is skipped.
            await fs.mkdir(path.join(root, "contoso.widgets", "2.0.0"), { recursive: true });
            const hits = await searchLocalPackages(root, "widgets", 10);
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].id, "Contoso.Widgets");
            assert.deepStrictEqual(hits[0].versions, ["1.1.0", "1.0.0"]);
            assert.strictEqual(hits[0].source, "local");
            assert.strictEqual(hits[0].description, "Widgets");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
