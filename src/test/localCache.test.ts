import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fetchOnlineJson } from "../services/OnlineFetch";
import { highestPatchFromLocal } from "../services/PatchFallback";
import {
    defaultHttpCachePath,
    parseRegistrationPublished,
    parseVulnerabilityData,
    publishedFrom,
    readLocalPublishedDates,
    readLocalVersions,
    readLocalVulnerabilities,
} from "../services/NuGetLocalCache";
import { PackageInfo } from "../models/PackageInfo";

async function cacheTree(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "packagehub-cache-"));
    const feed = path.join(root, "670c1461c29885f9aa22c281d8b7da90845b38e4");
    await fs.mkdir(feed, { recursive: true });
    await fs.writeFile(path.join(feed, "vuln_data_base.dat"), "https://api.nuget.org/v3/vulnerabilities/base.json\n" + JSON.stringify({
        "newtonsoft.json": [{ url: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr", severity: 2, versions: "(, 13.0.1)" }],
    }));
    await fs.writeFile(path.join(feed, "vuln_data_update.dat"), JSON.stringify({
        "newtonsoft.json": [{ url: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr", severity: 2, versions: "(, 13.0.1)" }],
        "system.text.json": [{ url: "https://github.com/advisories/GHSA-x", severity: 3, versions: "[8.0.0, 8.0.4)" }],
    }));
    await fs.writeFile(path.join(feed, "list_newtonsoft.json.dat"), JSON.stringify({ versions: ["12.0.1", "12.0.2", "12.0.3", "13.0.1"] }));
    await fs.writeFile(path.join(feed, "list_newtonsoft.json_index.dat"), "url\n" + JSON.stringify({
        items: [{ items: [
            { catalogEntry: { version: "12.0.3", published: "2019-11-09T01:27:30.723+00:00" } },
            { catalogEntry: { version: "13.0.1", published: "2021-03-22T20:10:12.457+00:00" } },
            { catalogEntry: { version: "13.0.2-beta1", published: "1900-01-01T00:00:00+00:00" } },
        ] }],
    }));
    return root;
}

suite("Local NuGet cache", () => {
    test("vulnerability files are read and merged", async () => {
        const root = await cacheTree();
        const advisories = await readLocalVulnerabilities(root);
        assert.deepStrictEqual(advisories.map((item) => [item.packageId, item.severity, item.versions]), [
            ["newtonsoft.json", "High", "(, 13.0.1)"],
            ["system.text.json", "Critical", "[8.0.0, 8.0.4)"],
        ]);
        assert.deepStrictEqual(await readLocalVulnerabilities(path.join(root, "missing")), []);
        await fs.rm(root, { recursive: true, force: true });
    });

    test("bad vulnerability data is skipped", () => {
        assert.deepStrictEqual(parseVulnerabilityData([1, 2]), []);
        assert.deepStrictEqual(parseVulnerabilityData({ a: [{ url: 1 }] }), []);
    });

    test("publish dates come from cached registration data, unlisted dates are dropped", async () => {
        const root = await cacheTree();
        const dates = await readLocalPublishedDates(root, "Newtonsoft.Json");
        assert.strictEqual(publishedFrom(dates, "13.0.1")?.toISOString(), "2021-03-22T20:10:12.457Z");
        assert.strictEqual(publishedFrom(dates, "13.0.2-beta1"), undefined);
        assert.strictEqual(parseRegistrationPublished(undefined).size, 0);
        await fs.rm(root, { recursive: true, force: true });
    });

    test("highest patch falls back to the cached version list", async () => {
        const root = await cacheTree();
        assert.deepStrictEqual((await readLocalVersions(root, "Newtonsoft.Json")).sort(), ["12.0.1", "12.0.2", "12.0.3", "13.0.1"]);
        const pkg = { id: "Newtonsoft.Json", version: "12.0.1", resolvedVersion: "12.0.1" } as PackageInfo;
        const result = await highestPatchFromLocal([pkg], false, root);
        assert.strictEqual(result[0].latestVersion, "12.0.3");
        assert.deepStrictEqual(await highestPatchFromLocal([pkg], false, undefined), []);
        await fs.rm(root, { recursive: true, force: true });
    });

    test("the default http-cache path follows the platform", () => {
        assert.strictEqual(defaultHttpCachePath("linux", { NUGET_HTTP_CACHE_PATH: "/x" }, "/home/me"), "/x");
        assert.strictEqual(defaultHttpCachePath("linux", {}, "/home/me"), path.join("/home/me", ".local", "share", "NuGet", "http-cache"));
        assert.strictEqual(defaultHttpCachePath("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\me"), path.join("C:\\L", "NuGet", "v3-cache"));
    });
});

suite("Online lookups", () => {
    test("the only network helper refuses while packageHub.onlineLookups is off", async () => {
        await assert.rejects(fetchOnlineJson("https://api.nuget.org/v3/index.json"), /onlineLookups is off/);
    });
});
