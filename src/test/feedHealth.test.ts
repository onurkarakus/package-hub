import * as assert from "assert";
import {
    buildFeedStatuses,
    credentialHints,
    feedFailuresFromAssetsLogs,
    parseFeedFailures,
    parseSourceList,
} from "../services/FeedHealth";

const SOURCES = [
    "Registered Sources:",
    "",
    "  1.  nuget.org [Enabled]",
    "      https://api.nuget.org/v3/index.json",
    "  2.  Company Feed [Disabled]",
    "      https://pkgs.dev.azure.com/acme/_packaging/main/nuget/v3/index.json",
    "  3.  local [Enabled]",
    "      /home/me/packages",
    "  4.  github [Enabled]",
    "      https://nuget.pkg.github.com/acme/index.json",
].join("\n");

suite("Feed health", () => {
    test("dotnet nuget list source is parsed", () => {
        assert.deepStrictEqual(parseSourceList(SOURCES), [
            { name: "nuget.org", url: "https://api.nuget.org/v3/index.json", enabled: true },
            { name: "Company Feed", url: "https://pkgs.dev.azure.com/acme/_packaging/main/nuget/v3/index.json", enabled: false },
            { name: "local", url: "/home/me/packages", enabled: true },
            { name: "github", url: "https://nuget.pkg.github.com/acme/index.json", enabled: true },
        ]);
        assert.deepStrictEqual(parseSourceList("No sources found."), []);
    });

    test("NU1301 and NU1801 lines are read with url and status", () => {
        const output = [
            "/repo/Api/Api.csproj : error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/acme/index.json. [/repo/Api/Api.csproj]",
            "/repo/Api/Api.csproj : warning NU1801: Response status code does not indicate success: 401 (Unauthorized). https://pkgs.dev.azure.com/acme/_packaging/main/nuget/v3/index.json",
            "/repo/Api/Api.csproj : error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/acme/index.json. [/repo/Api/Api.csproj]",
            "  Restored /repo/Api/Api.csproj (in 1.2 sec).",
            "warning NU1302: You are running the 'restore' operation with an 'HTTP' source: http://feed.local/v3/index.json.",
        ].join("\n");
        const failures = parseFeedFailures(output, 1);
        assert.deepStrictEqual(failures.map((failure) => [failure.code, failure.url, failure.status]), [
            ["NU1301", "https://nuget.pkg.github.com/acme/index.json", undefined],
            ["NU1801", "https://pkgs.dev.azure.com/acme/_packaging/main/nuget/v3/index.json", 401],
            ["NU1302", "http://feed.local/v3/index.json", undefined],
        ]);
        assert.ok(failures[0].message.startsWith("Unable to load the service index"));
    });

    test("restore logs in project.assets.json are read", () => {
        const failures = feedFailuresFromAssetsLogs([
            { code: "NU1905", level: "Warning", message: "Audit source 'nuget.org' did not provide any vulnerability data." },
            { code: "NU1603", level: "Warning", message: "Not a feed failure." },
        ], 1);
        assert.deepStrictEqual(failures.map((failure) => failure.code), ["NU1905"]);
        assert.deepStrictEqual(feedFailuresFromAssetsLogs(undefined), []);
    });

    test("failures are matched to sources by url or name, the rest are unmatched", () => {
        const sources = parseSourceList(SOURCES);
        const failures = parseFeedFailures([
            "error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/acme/index.json.",
            "warning NU1905: Audit source 'nuget.org' did not provide any vulnerability data.",
            "error NU1301: Unable to load the service index for source https://other.example/v3/index.json.",
        ].join("\n"), 1);
        const { statuses, unmatched } = buildFeedStatuses(sources, failures, []);
        assert.strictEqual(statuses.find((status) => status.name === "github")?.failures.length, 1);
        assert.strictEqual(statuses.find((status) => status.name === "nuget.org")?.failures[0].code, "NU1905");
        assert.strictEqual(statuses.find((status) => status.name === "local")?.failures.length, 0);
        assert.deepStrictEqual(unmatched.map((failure) => failure.url), ["https://other.example/v3/index.json"]);
    });

    test("credential hints are text only", () => {
        const azure = { name: "a", url: "https://pkgs.dev.azure.com/acme/_packaging/x/nuget/v3/index.json", enabled: true };
        assert.match(credentialHints(azure, [], [])[0], /Azure Artifacts Credential Provider/);
        const unauthorized = [{ code: "NU1301", message: "401", status: 401, at: 1 }];
        assert.match(credentialHints(azure, unauthorized, ["CredentialProvider.Microsoft"])[0], /--interactive/);
        const plain = { name: "p", url: "http://feed.local/v3/index.json", enabled: true };
        assert.ok(credentialHints(plain, [], []).some((hint) => /plain HTTP/.test(hint)));
        const other = { name: "o", url: "https://feed.example/v3/index.json", enabled: true };
        assert.ok(credentialHints(other, unauthorized, []).some((hint) => /401\/403/.test(hint)));
        assert.deepStrictEqual(credentialHints(other, [], []), []);
    });
});
