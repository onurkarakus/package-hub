import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { escapeMarkdown, HOVER_COMMANDS, safeAdvisoryUrl } from "../providers/PackageHoverProvider";
import { dashboardHtml, escapeHtml, isActionId, makeNonce, readDashboardMessage } from "../webview/HealthDashboardPanel";

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
        assert.deepStrictEqual(readDashboardMessage({ command: "applyAction", actionId: "patch" }), { command: "applyAction", actionId: "patch" });
        assert.deepStrictEqual(readDashboardMessage({ command: "previewAction", actionId: "pin:Azure.Identity" }), {
            command: "previewAction", actionId: "pin:Azure.Identity",
        });
        assert.strictEqual(readDashboardMessage({ command: "applyAction", actionId: "pin:A; rm -rf" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "applyAction", actionId: "major" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "applyAction" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "safeUpdate", channel: "patch" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "setViewMode", mode: "byProject" }), undefined);
        assert.deepStrictEqual(readDashboardMessage({ command: "openAdvisory", url: "https://github.com/advisories/GHSA-1" }), {
            command: "openAdvisory", url: "https://github.com/advisories/GHSA-1",
        });
        assert.strictEqual(readDashboardMessage({ command: "openAdvisory", url: "javascript:alert(1)" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "openAdvisory", url: "command:packageHub.removePackage" }), undefined);
        assert.strictEqual(readDashboardMessage({ command: "showDependencies", packageId: "../x" }), undefined);
        assert.deepStrictEqual(readDashboardMessage({ command: "ready" }), { command: "ready" });
        assert.strictEqual(readDashboardMessage({ command: "runShell" }), undefined);
        assert.strictEqual(readDashboardMessage("refresh"), undefined);
        assert.strictEqual(readDashboardMessage(null), undefined);
    });

    test("action ids are whitelisted", () => {
        assert.strictEqual(isActionId("patch"), true);
        assert.strictEqual(isActionId("minor"), true);
        assert.strictEqual(isActionId("update:Newtonsoft.Json"), true);
        assert.strictEqual(isActionId("replace:Microsoft.Azure.ServiceBus"), true);
        assert.strictEqual(isActionId("update:"), false);
        assert.strictEqual(isActionId("update:<b>"), false);
        assert.strictEqual(isActionId("remove:Newtonsoft.Json"), false);
        assert.strictEqual(isActionId(42), false);
    });

    test("the dashboard page has a nonce CSP and no inline script or style", () => {
        const html = dashboardHtml({
            cspSource: "vscode-resource:",
            nonce: "abc123",
            scriptUri: "vscode-resource:/media/dashboard.js\"><script>",
            styleUri: "vscode-resource:/media/dashboard.css",
        });
        const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]?.replace(/&#39;/g, "'");
        assert.strictEqual(csp, "default-src 'none'; style-src vscode-resource:; script-src 'nonce-abc123'; img-src vscode-resource:; font-src vscode-resource:");
        assert.ok(!/unsafe-inline|unsafe-eval/.test(html));
        assert.ok(!/\son[a-z]+=/i.test(html), "no inline event handlers");
        assert.ok(!/\sstyle=/i.test(html), "no inline style attributes");
        assert.ok(!/<style/i.test(html));
        const scripts = html.match(/<script[^>]*>/g) ?? [];
        assert.strictEqual(scripts.length, 1);
        assert.match(scripts[0], /nonce="abc123"/);
        assert.match(scripts[0], /src="vscode-resource:\/media\/dashboard\.js&quot;&gt;&lt;script&gt;"/);
    });

    test("the dashboard script and styles stay local", () => {
        const media = path.resolve(__dirname, "../../media");
        const script = fs.readFileSync(path.join(media, "dashboard.js"), "utf8");
        const styles = fs.readFileSync(path.join(media, "dashboard.css"), "utf8");
        assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\beval\s*\(|new Function/.test(script));
        assert.ok(!/https?:\/\//.test(styles));
        assert.ok(!/@import/.test(styles));
        assert.ok(/acquireVsCodeApi\(\)/.test(script));
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
