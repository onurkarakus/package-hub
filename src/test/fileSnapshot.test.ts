import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FileSnapshot } from "../services/FileSnapshot";

suite("File snapshot", () => {
    test("puts changed files back and deletes files that did not exist", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "ph-snap-"));
        try {
            const project = path.join(root, "App.csproj");
            const lock = path.join(root, "packages.lock.json");
            await fs.writeFile(project, "<Project>before</Project>");
            const snapshot = new FileSnapshot();
            await snapshot.capture([project, lock, project]);
            assert.strictEqual(snapshot.size, 2);

            await fs.writeFile(project, "<Project>after</Project>");
            await fs.writeFile(lock, "{}");
            assert.deepStrictEqual((await snapshot.changed()).sort(), [lock, project].sort());

            const result = await snapshot.restore();
            assert.deepStrictEqual(result.failed, []);
            assert.strictEqual(await fs.readFile(project, "utf8"), "<Project>before</Project>");
            await assert.rejects(fs.access(lock));
            assert.deepStrictEqual(await snapshot.changed(), []);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
