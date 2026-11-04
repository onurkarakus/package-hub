import * as assert from "assert";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DOTNET_ENVIRONMENT, DotnetCli, DotnetCommandError, dotnetEnvironment, InvalidArgumentError } from "../services/DotnetCli";
import { TargetUnreadableError } from "../services/PackageList";

/**
 * A node binary for the fake. Inside the extension host process.execPath is
 * the editor; a real node on PATH is more reliable across editor versions.
 */
function nodeBinary(): string {
    const names = process.platform === "win32" ? ["node.exe"] : ["node"];
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (fsSync.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return process.execPath;
}

/**
 * A fake dotnet: it records its arguments and environment, then prints what
 * the test asked for.
 */
async function fakeDotnet(script: string): Promise<{ command: string; log: string; dir: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "packagehub-fake-dotnet-"));
    const log = path.join(dir, "calls.jsonl");
    const program = path.join(dir, "fake.js");
    await fs.writeFile(path.join(dir, "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />");
    await fs.writeFile(program, [
        "const fs = require('fs');",
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), lang: process.env.DOTNET_CLI_UI_LANGUAGE, telemetry: process.env.DOTNET_CLI_TELEMETRY_OPTOUT }) + '\\n');`,
        "const args = process.argv.slice(2);",
        script,
    ].join("\n"));
    let command: string;
    if (process.platform === "win32") {
        command = path.join(dir, "dotnet.cmd");
        await fs.writeFile(command, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${nodeBinary()}" "${program}" %*\r\n`);
    } else {
        command = path.join(dir, "dotnet");
        await fs.writeFile(command, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeBinary()}" "${program}" "$@"\n`);
        await fs.chmod(command, 0o755);
    }
    return { command, log, dir };
}

async function calls(log: string): Promise<{ args: string[]; lang?: string; telemetry?: string }[]> {
    const text = await fs.readFile(log, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const supported = process.platform !== "win32";

suite("DotnetCli processes", () => {
    test("the environment makes dotnet output stable", () => {
        const env = dotnetEnvironment({ PATH: "/bin", DOTNET_CLI_UI_LANGUAGE: "tr" }, { EXTRA: "1" });
        assert.strictEqual(env.DOTNET_CLI_UI_LANGUAGE, "en");
        assert.strictEqual(env.DOTNET_NOLOGO, "1");
        assert.strictEqual(env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE, "1");
        assert.strictEqual(env.DOTNET_CLI_TELEMETRY_OPTOUT, "1");
        assert.strictEqual(env.EXTRA, "1");
        assert.strictEqual(Object.keys(DOTNET_ENVIRONMENT).length, 4);
    });

    test("invalid ids and versions never reach dotnet", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet("process.exit(0);");
        const cli = new DotnetCli(undefined, fake.command);
        const project = path.join(fake.dir, "App.csproj");
        await assert.rejects(cli.updatePackage(project, "A; rm -rf /", "1.0.0"), InvalidArgumentError);
        await assert.rejects(cli.updatePackage(project, "A", "1.0.0 && echo"), InvalidArgumentError);
        await assert.rejects(cli.removePackage(project, "$(evil)"), InvalidArgumentError);
        await assert.rejects(cli.updatePackage("relative.csproj", "A", "1.0.0"), InvalidArgumentError);
        assert.deepStrictEqual(await calls(fake.log), []);
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("update passes an argument array and the stable environment", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet("process.exit(0);");
        const cli = new DotnetCli(undefined, fake.command);
        const project = path.join(fake.dir, "My App", "App.csproj");
        await fs.mkdir(path.dirname(project), { recursive: true });
        await cli.updatePackage(project, "Newtonsoft.Json", "13.0.3");
        const [call] = await calls(fake.log);
        assert.deepStrictEqual(call.args, ["add", project, "package", "Newtonsoft.Json", "--version", "13.0.3"]);
        assert.strictEqual(call.lang, "en");
        assert.strictEqual(call.telemetry, "1");
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("a failing update or restore throws with the exit code and error lines", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet([
            "console.log('  Determining projects to restore...');",
            "console.log('/x/App.csproj : error NU1101: Unable to find package Nope. No packages exist with this id in source(s): nuget.org');",
            "process.exit(1);",
        ].join("\n"));
        const cli = new DotnetCli(undefined, fake.command);
        const project = path.join(fake.dir, "App.csproj");
        await assert.rejects(cli.updatePackage(project, "Nope", "1.0.0"), (error: unknown) =>
            error instanceof DotnetCommandError
            && error.exitCode === 1
            && /exit code 1/.test(error.message)
            && /NU1101/.test(error.message)
        );
        await assert.rejects(cli.restore(project), DotnetCommandError);
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("list output that is not JSON is unreadable, not healthy", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet("console.log('Something went wrong'); process.exit(0);");
        const cli = new DotnetCli(undefined, fake.command);
        await assert.rejects(cli.listVulnerable(path.join(fake.dir, "App.csproj")), TargetUnreadableError);
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("a failing list with no JSON is a command error", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet("console.error('error: Sequence contains no matching element'); process.exit(1);");
        const cli = new DotnetCli(undefined, fake.command);
        await assert.rejects(cli.listOutdated(path.join(fake.dir, "App.csproj")), (error: unknown) =>
            error instanceof DotnetCommandError && /Sequence contains no matching element/.test(error.message)
        );
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("list JSON with an error problem for the target is unreadable", async function () {
        if (!supported) { this.skip(); }
        const json = JSON.stringify({ version: 1, problems: [{ level: "error", text: "No assets file was found." }], projects: [] });
        const fake = await fakeDotnet(`console.log(${JSON.stringify(json)}); process.exit(0);`);
        const cli = new DotnetCli(undefined, fake.command);
        await assert.rejects(cli.listVulnerable(path.join(fake.dir, "App.csproj")), TargetUnreadableError);
        await fs.rm(fake.dir, { recursive: true, force: true });
    });

    test("listeners see the output so feed failures can be read", async function () {
        if (!supported) { this.skip(); }
        const fake = await fakeDotnet("console.log('error NU1301: Unable to load the service index for source https://feed.example/v3/index.json.'); process.exit(1);");
        const cli = new DotnetCli(undefined, fake.command);
        const seen: string[] = [];
        const listener = cli.onOutput((output) => seen.push(output.stdout));
        await assert.rejects(cli.restore(fake.dir));
        listener.dispose();
        assert.strictEqual(seen.length, 1);
        assert.match(seen[0], /NU1301/);
        await fs.rm(fake.dir, { recursive: true, force: true });
    });
});
