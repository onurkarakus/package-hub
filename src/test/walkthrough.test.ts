import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { welcomeState } from "../services/welcomeState";

type Step = { id: string; media: { image?: string; markdown?: string }; completionEvents?: string[] };

suite("Get Started", () => {
    test("the welcome state follows folders and projects", () => {
        assert.strictEqual(welcomeState(0, 0), "noFolder");
        assert.strictEqual(welcomeState(1, 0), "noProjects");
        assert.strictEqual(welcomeState(2, 3), undefined);
    });

    test("the walkthrough ships every media file it references", async () => {
        const extension = vscode.extensions.getExtension("onurkarakus.package-hub");
        assert.ok(extension);
        const walkthroughs = extension.packageJSON.contributes.walkthroughs as { id: string; steps: Step[] }[];
        assert.strictEqual(walkthroughs.length, 1);
        assert.strictEqual(walkthroughs[0].id, "packageHub.getStarted");
        assert.ok(walkthroughs[0].steps.length >= 5);

        for (const step of walkthroughs[0].steps) {
            const file = step.media.image ?? step.media.markdown;
            assert.ok(file, `${step.id} has no media`);
            await fs.access(path.join(extension.extensionPath, file));
            assert.ok((step.completionEvents ?? []).length > 0, `${step.id} has no completion event`);
        }
    });

    test("the first-scan step completes on any scan, including the startup scan", () => {
        const extension = vscode.extensions.getExtension("onurkarakus.package-hub");
        assert.ok(extension);
        const [walkthrough] = extension.packageJSON.contributes.walkthroughs as { steps: Step[] }[];
        const scan = walkthrough.steps.find((step) => step.id === "packageHub.scan");
        assert.ok(scan?.completionEvents?.includes("onContext:packageHub.scanCompleted"));
    });

    test("every command link in the manifest strings is a real command", async () => {
        const extension = vscode.extensions.getExtension("onurkarakus.package-hub");
        assert.ok(extension);
        await extension.activate();
        const nls = JSON.parse(
            await fs.readFile(path.join(extension.extensionPath, "package.nls.json"), "utf8")
        ) as Record<string, string>;
        const commands = new Set(await vscode.commands.getCommands(true));
        const links = Object.values(nls).flatMap((text) =>
            [...text.matchAll(/\(command:([\w.]+)/g)].map((match) => match[1])
        );
        assert.ok(links.includes("packageHub.openWalkthrough"));
        // Why needs a package from the editor line or the tree, so the walkthrough does not link it bare.
        assert.ok(!links.includes("packageHub.whyPackage"));
        for (const id of links) {
            assert.ok(commands.has(id), `${id} is not a registered command`);
        }
    });

    test("every manifest string placeholder has a value", async () => {
        const extension = vscode.extensions.getExtension("onurkarakus.package-hub");
        assert.ok(extension);
        const root = extension.extensionPath;
        const manifest = await fs.readFile(path.join(root, "package.json"), "utf8");
        const nls = JSON.parse(await fs.readFile(path.join(root, "package.nls.json"), "utf8")) as Record<string, string>;
        for (const match of manifest.matchAll(/"%([\w.]+)%"/g)) {
            assert.ok(nls[match[1]], `${match[1]} is missing in package.nls.json`);
        }
    });

    test("Get Started is registered", async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("packageHub.openWalkthrough"));
    });
});
