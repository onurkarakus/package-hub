import * as fs from "fs/promises";
import * as path from "path";

/**
 * Keeps the exact bytes of a set of files so a batch of writes can be undone.
 * A file that did not exist when the snapshot was taken is deleted again on
 * rollback.
 */
export class FileSnapshot {
    private readonly files = new Map<string, Buffer | null>();

    get size(): number {
        return this.files.size;
    }

    paths(): string[] {
        return [...this.files.keys()];
    }

    async capture(filePaths: Iterable<string>): Promise<void> {
        for (const filePath of filePaths) {
            const key = path.resolve(filePath);
            if (this.files.has(key)) {
                continue;
            }
            try {
                this.files.set(key, await fs.readFile(key));
            } catch {
                this.files.set(key, null);
            }
        }
    }

    /** Files whose bytes differ from the snapshot now. */
    async changed(): Promise<string[]> {
        const result: string[] = [];
        for (const [filePath, before] of this.files) {
            let now: Buffer | null;
            try {
                now = await fs.readFile(filePath);
            } catch {
                now = null;
            }
            if (before === null ? now !== null : now === null || !before.equals(now)) {
                result.push(filePath);
            }
        }
        return result;
    }

    /**
     * Writes back every changed file. Returns the files that were put back and
     * the ones that could not be.
     */
    async restore(): Promise<{ restored: string[]; failed: string[] }> {
        const restored: string[] = [];
        const failed: string[] = [];
        for (const filePath of await this.changed()) {
            const before = this.files.get(filePath);
            try {
                if (before === null || before === undefined) {
                    await fs.rm(filePath, { force: true });
                } else {
                    await fs.writeFile(filePath, before);
                }
                restored.push(filePath);
            } catch {
                failed.push(filePath);
            }
        }
        return { restored, failed };
    }
}
