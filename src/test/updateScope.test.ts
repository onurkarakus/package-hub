import * as assert from "assert";
import { projectScope, withoutDowngrades } from "../services/UpdateScope";

suite("Update scope", () => {
    test("the projects argument is read as a case-insensitive set", () => {
        assert.deepStrictEqual([...projectScope(["Shop.Api", "shop.worker"])!], ["shop.api", "shop.worker"]);
        assert.deepStrictEqual([...projectScope([])!], []);
        assert.strictEqual(projectScope(undefined), undefined);
        assert.strictEqual(projectScope("Shop.Api"), undefined);
        assert.strictEqual(projectScope(["Shop.Api", 3]), undefined);
        assert.strictEqual(projectScope([""]), undefined);
    });

    test("targets already newer than the version are skipped", () => {
        const targets = [
            { name: "Shop.Api", version: "12.0.1" },
            { name: "Shop.Worker", version: "13.0.4" },
            { name: "Shop.Tests", version: "13.0.1" },
            { name: "Shop.Legacy", version: undefined },
        ];
        const { kept, skipped } = withoutDowngrades(targets, "13.0.1", (target) => target.version);
        assert.deepStrictEqual(kept.map((t) => t.name), ["Shop.Api", "Shop.Tests", "Shop.Legacy"]);
        assert.deepStrictEqual(skipped.map((t) => `${t.name} ${t.from}`), ["Shop.Worker 13.0.4"]);
    });

    test("without a version nothing is skipped", () => {
        const targets = [{ name: "Shop.Worker", version: "13.0.4" }];
        assert.deepStrictEqual(withoutDowngrades(targets, undefined, (t) => t.version), { kept: targets, skipped: [] });
    });
});
