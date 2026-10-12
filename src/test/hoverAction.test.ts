import * as assert from "assert";
import { hoverActionChip } from "../providers/PackageHoverProvider";

const hoverSpanStyle =
    /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

suite("Hover action chip", () => {
    test("the preferred update uses the primary button colors", () => {
        const chip = hoverActionChip(
            "arrow-circle-up",
            "Highest patch 12.0.3",
            "command:packageHub.updateVulnerable?%7B%7D",
            true
        );
        const style = /style="([^"]+)"/.exec(chip)?.[1] ?? "";
        assert.match(style, hoverSpanStyle);
        assert.ok(style.includes("var(--vscode-button-foreground)"));
        assert.ok(style.includes("var(--vscode-button-background)"));
        assert.ok(chip.includes("$(arrow-circle-up)"));
        assert.ok(chip.includes("Highest patch 12.0.3"));
        assert.ok(!chip.includes("<br"));
    });

    test("the other actions use the secondary button colors", () => {
        const chip = hoverActionChip("trash", "Remove", "command:packageHub.removePackage");
        const style = /style="([^"]+)"/.exec(chip)?.[1] ?? "";
        assert.match(style, hoverSpanStyle);
        assert.ok(style.includes("var(--vscode-button-secondaryForeground)"));
        assert.ok(style.includes("var(--vscode-button-secondaryBackground)"));
        assert.ok(!style.includes("var(--vscode-button-background)"));
    });

    test("the label and the address stay escaped", () => {
        const chip = hoverActionChip("tag", "A<B>", `https://example.com/?a=1&b="c"`);
        assert.ok(chip.includes("A&lt;B&gt;"));
        assert.ok(chip.includes("a=1&amp;b=&quot;c&quot;"));
        assert.ok(!chip.includes(`b="c"`));
    });
});
