import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { DASHBOARD_STRINGS } from "../webview/dashboardStrings";

const root = path.resolve(__dirname, "../..");

function readJson(file: string): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "test" ? [] : sourceFiles(full);
        }
        return entry.name.endsWith(".ts") ? [full] : [];
    });
}

function placeholders(text: string): string[] {
    return (text.match(/\{\d+\}/g) ?? []).sort();
}

suite("Localization", () => {
    test("package.nls.tr.json translates every package.nls.json key", () => {
        const english = readJson("package.nls.json");
        const turkish = readJson("package.nls.tr.json");
        assert.deepStrictEqual(Object.keys(turkish).sort(), Object.keys(english).sort());
        for (const [key, value] of Object.entries(turkish)) {
            assert.ok(value.trim(), `${key} is empty`);
        }
    });

    test("the Turkish bundle covers every runtime and page string", () => {
        const bundle = readJson("l10n/bundle.l10n.tr.json");
        const keys = new Set<string>(DASHBOARD_STRINGS);
        const call = /l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;
        for (const file of sourceFiles(path.join(root, "src"))) {
            for (const match of fs.readFileSync(file, "utf8").matchAll(call)) {
                keys.add(JSON.parse(`"${match[1]}"`));
            }
        }
        const missing = [...keys].filter((key) => typeof bundle[key] !== "string" || !bundle[key].trim());
        assert.deepStrictEqual(missing, []);
        for (const key of keys) {
            assert.deepStrictEqual(placeholders(bundle[key]), placeholders(key), `placeholders differ for: ${key}`);
        }
    });

    test("the dashboard string list matches the page script", () => {
        const script = fs.readFileSync(path.join(root, "media", "dashboard.js"), "utf8");
        const used = new Set<string>();
        for (const match of script.matchAll(/\bT\("((?:[^"\\]|\\.)+)"/g)) {
            used.add(JSON.parse(`"${match[1]}"`));
        }
        for (const match of script.matchAll(/\bplural\([^,]+, "((?:[^"\\]|\\.)+)", "((?:[^"\\]|\\.)+)"\)/g)) {
            used.add(JSON.parse(`"${match[1]}"`));
            used.add(JSON.parse(`"${match[2]}"`));
        }
        assert.deepStrictEqual([...used].sort(), [...DASHBOARD_STRINGS].sort());
    });

    test("package.json points at the l10n folder", () => {
        const manifest = readJson("package.json") as unknown as { l10n?: string };
        assert.strictEqual(manifest.l10n, "./l10n");
    });
});
