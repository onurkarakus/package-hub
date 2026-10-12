import * as assert from "assert";
import { resolveLensPatch } from "../providers/PackageCodeLensProvider";

suite("CodeLens patch", () => {
    test("a ready list wins over the saved patch", () => {
        assert.strictEqual(
            resolveLensPatch("12.0.3", { ready: true, patch: "12.0.4" }),
            "12.0.4"
        );
    });

    test("a ready list with no patch does not reuse the saved one", () => {
        assert.strictEqual(
            resolveLensPatch("12.0.3", { ready: true }),
            undefined
        );
    });

    test("a cold list uses the saved highest patch", () => {
        assert.strictEqual(
            resolveLensPatch("12.0.3", { ready: false }),
            "12.0.3"
        );
    });

    test("a cold list without a saved patch stays empty", () => {
        assert.strictEqual(
            resolveLensPatch(undefined, { ready: false }),
            undefined
        );
    });
});
