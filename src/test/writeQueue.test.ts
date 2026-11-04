import * as assert from "assert";
import { Debouncer, WriteQueue } from "../services/WriteQueue";
import { planScanTargets } from "../services/SolutionTargets";

suite("Write queue and scan plan", () => {
    test("writes run one at a time, in order, even after a failure", async () => {
        const queue = new WriteQueue();
        const log: string[] = [];
        let running = 0;
        const job = (name: string, fail = false) => queue.run(async () => {
            running += 1;
            assert.strictEqual(running, 1);
            log.push(`start ${name}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            log.push(`end ${name}`);
            running -= 1;
            if (fail) {
                throw new Error(name);
            }
            return name;
        });
        const results = await Promise.allSettled([job("a"), job("b", true), job("c")]);
        assert.deepStrictEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
        assert.deepStrictEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
        assert.strictEqual(queue.busy, false);
    });

    test("the debouncer runs once with every item", async () => {
        const calls: string[][] = [];
        const debouncer = new Debouncer<string>(30, (items) => calls.push(items));
        debouncer.trigger("a");
        debouncer.trigger("b");
        debouncer.trigger("a");
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.deepStrictEqual(calls, [["a", "b"]]);
        debouncer.trigger("c");
        debouncer.dispose();
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.strictEqual(calls.length, 1);
    });

    test("overlapping solutions are deduped and loose projects are scanned", () => {
        const plan = planScanTargets(
            [
                { solutionPath: "/r/Small.sln", projects: ["/r/A/A.csproj"] },
                { solutionPath: "/r/All.sln", projects: ["/r/A/A.csproj", "/r/B/B.csproj"] },
                { solutionPath: "/r/Other.sln", projects: ["/r/B/B.csproj", "/r/C/C.csproj"] },
                { solutionPath: "/r/Broken.sln", projects: [], error: "unreadable" },
            ],
            ["/r/A/A.csproj", "/r/B/B.csproj", "/r/C/C.csproj", "/r/Loose/Loose.fsproj", "/r/Loose/Loose.fsproj"]
        );
        assert.deepStrictEqual(plan.solutions, ["/r/All.sln", "/r/Other.sln"]);
        assert.deepStrictEqual(plan.skippedSolutions, ["/r/Small.sln"]);
        assert.deepStrictEqual(plan.projects, ["/r/Loose/Loose.fsproj"]);
    });
});
