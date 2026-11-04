import * as assert from "assert";
import { CommandNotFoundError, errorLines, ProcessError, runProcess, Semaphore } from "../services/ProcessRunner";

const node = process.execPath;
const cwd = process.cwd();
// Inside the extension host process.execPath is the editor binary; this makes it act as node.
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

suite("Process runner", () => {
    test("arguments are passed without a shell", async () => {
        const tricky = "a; echo injected && $(whoami) `id` | cat > x";
        const result = await runProcess(node, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", tricky], {
            cwd,
            timeoutMs: 20000,
            env,
        });
        assert.strictEqual(result.exitCode, 0);
        assert.deepStrictEqual(JSON.parse(result.stdout), [tricky]);
    });

    test("exit code and stderr come back", async () => {
        const result = await runProcess(node, ["-e", "console.error('boom'); process.exit(3)"], { cwd, timeoutMs: 20000, env });
        assert.strictEqual(result.exitCode, 3);
        assert.match(result.stderr, /boom/);
    });

    test("environment is passed", async () => {
        const result = await runProcess(node, ["-e", "process.stdout.write(process.env.DOTNET_CLI_UI_LANGUAGE || '')"], {
            cwd,
            timeoutMs: 20000,
            env: { ...env, DOTNET_CLI_UI_LANGUAGE: "en" },
        });
        assert.strictEqual(result.stdout, "en");
    });

    test("a missing program is CommandNotFoundError", async () => {
        await assert.rejects(
            runProcess("packagehub-no-such-program", [], { cwd, timeoutMs: 5000 }),
            (error: unknown) => error instanceof CommandNotFoundError
        );
    });

    test("timeout kills the process", async () => {
        const started = Date.now();
        await assert.rejects(
            runProcess(node, ["-e", "setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 300, env }),
            (error: unknown) => error instanceof ProcessError && error.timedOut
        );
        assert.ok(Date.now() - started < 10000);
    });

    test("abort kills the process", async () => {
        const controller = new AbortController();
        const run = runProcess(node, ["-e", "setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 60000, signal: controller.signal, env });
        setTimeout(() => controller.abort(), 200);
        await assert.rejects(run, (error: unknown) => (error as Error).name === "AbortError");
    });

    test("the semaphore limits parallel work", async () => {
        const slots = new Semaphore(2);
        let running = 0;
        let peak = 0;
        await Promise.all(Array.from({ length: 6 }, async () => {
            const release = await slots.acquire();
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 20));
            running -= 1;
            release();
        }));
        assert.strictEqual(peak, 2);
    });

    test("an aborted waiter leaves the queue", async () => {
        const slots = new Semaphore(1);
        const release = await slots.acquire();
        const controller = new AbortController();
        const waiting = slots.acquire(controller.signal);
        controller.abort();
        await assert.rejects(waiting);
        release();
        const again = await slots.acquire();
        again();
    });

    test("error lines prefer error text", () => {
        const text = [
            "  Determining projects to restore...",
            "/repo/Api.csproj : error NU1101: Unable to find package Nope.",
            "  Failed to restore /repo/Api.csproj (in 1 sec).",
            "",
        ].join("\n");
        assert.deepStrictEqual(errorLines(text), [
            "/repo/Api.csproj : error NU1101: Unable to find package Nope.",
            "Failed to restore /repo/Api.csproj (in 1 sec).",
        ]);
        assert.deepStrictEqual(errorLines("only\nplain"), []);
        assert.strictEqual(errorLines("error: a\nerror: b\nerror: c", 2).length, 2);
    });
});
