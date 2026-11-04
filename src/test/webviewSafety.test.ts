import * as assert from "assert";
import { escapeMarkdown, HOVER_COMMANDS, safeAdvisoryUrl } from "../providers/PackageHoverProvider";
import { escapeHtml, feedHealthHtml, makeNonce, readDashboardMessage } from "../webview/HealthDashboardPanel";
import { isDashboardViewMode } from "../services/Settings";

suite("Webview and hover safety", () => {
    test("HTML is escaped", () => {
        assert.strictEqual(escapeHtml("<img src=x onerror=\"a\">&'"), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
        assert.strictEqual(escapeHtml(undefined), "");
        assert.strictEqual(escapeHtml(12), "12");
    });

    test("nonces are fresh and safe in an attribute", () => {
        const a = makeNonce();
        assert.match(a, /^[A-Za-z0-9]{16,}$/);
        assert.notStrictEqual(a, makeNonce());
    });

    test("dashboard messages are validated", () => {
        assert.deepStrictEqual(readDashboardMessage({ command: "refresh", extra: 1 }), { command: "refresh" });
        assert.deepStrictEqual(readDashboardMessage({ command: "updatePackage", packageId: "Newtonsoft.Json", version: "13.0.3" }), {
            command: "updatePackage", packageId: "Newtonsoft.Json", version: "13.0.3",
        });
        assert.deepStrictEqual(readDashboardMessage({ command: "updatePackage", packageId: "A", version: "" }), {
            command: "updatePackage", packageId: "A", version: undefined,
        });
        assert.strictEqual(readDashboardMessage({ command: "updatePackage", packageId: "A; rm", version: "1.0.0" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "updatePackage", packageId: "A", version: "1.0.0 --source evil" }), undefined);
        assert.deepStrictEqual(readDashboardMessage({ command: "safeUpdate", channel: "patch" }), { command: "safeUpdate", channel: "patch" });
        assert.strictEqual(readDashboardMessage({ command: "safeUpdate", channel: "major" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "setViewMode", mode: "<script>" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "setViewMode", mode: "byProject" })?.command, "setViewMode");
        assert.strictEqual(readDashboardMessage({ command: "runShell" }), undefined);
        assert.strictEqual(readDashboardMessage("refresh"), undefined);
        assert.strictEqual(readDashboardMessage(null), undefined);
        const filter = readDashboardMessage({ command: "filter", query: "x".repeat(500), severity: 3 });
        assert.deepStrictEqual(filter, { command: "filter", query: undefined, severity: undefined });
    });

    test("view modes are whitelisted", () => {
        assert.strictEqual(isDashboardViewMode("list"), true);
        assert.strictEqual(isDashboardViewMode("byPackage"), true);
        assert.strictEqual(isDashboardViewMode("grid"), false);
        assert.strictEqual(isDashboardViewMode(undefined), false);
    });

    test("feed health HTML escapes source data", () => {
        const html = feedHealthHtml({
            sources: [{ name: "<b>evil</b>", url: "https://x/\"><script>", enabled: true }],
            failures: [],
            unmatched: [{ code: "NU1301", message: "<img onerror=x>", at: 1 }],
            statuses: [{
                name: "<b>evil</b>",
                url: "https://x/\"><script>",
                enabled: true,
                failures: [{ code: "NU1301", message: "<i>down</i>", at: 1 }],
                hints: ["<u>hint</u>"],
            }],
            credentialProviders: [],
        }, false);
        assert.ok(!/<script>|<b>|<img|<i>|<u>/.test(html));
        assert.match(html, /Failed in the last scan/);
        assert.match(html, /no network request of its own/);
        assert.match(feedHealthHtml({ failures: [], unmatched: [], statuses: [], credentialProviders: [] }, true), /did not list the sources/);
    });

    test("markdown in package ids is escaped", () => {
        const escaped = escapeMarkdown("[click](command:workbench.action.terminal.new)");
        assert.ok(!escaped.includes("](command:"));
        assert.strictEqual(escapeMarkdown("Newtonsoft.Json"), "Newtonsoft\\.Json");
        assert.ok(!escapeMarkdown("<b>").includes("<"));
    });

    test("only https advisory urls are linked", () => {
        assert.strictEqual(safeAdvisoryUrl("https://github.com/advisories/GHSA-1"), "https://github.com/advisories/GHSA-1");
        assert.strictEqual(safeAdvisoryUrl("http://example.com"), undefined);
        assert.strictEqual(safeAdvisoryUrl("command:packageHub.removePackage"), undefined);
        assert.strictEqual(safeAdvisoryUrl("javascript:alert(1)"), undefined);
        assert.strictEqual(safeAdvisoryUrl("not a url"), undefined);
        assert.strictEqual(safeAdvisoryUrl(undefined), undefined);
    });

    test("the hover whitelist names only PackageHub commands", () => {
        assert.ok(HOVER_COMMANDS.length > 0);
        assert.ok(HOVER_COMMANDS.every((command) => command.startsWith("packageHub.")));
    });
});
