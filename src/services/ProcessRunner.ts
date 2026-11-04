import { ChildProcess, spawn } from "child_process";

export interface RunOptions {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    maxBufferBytes?: number;
}

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export class ProcessError extends Error {
    constructor(
        message: string,
        readonly exitCode: number | null,
        readonly stdout: string,
        readonly stderr: string,
        readonly timedOut = false
    ) {
        super(message);
        this.name = "ProcessError";
    }
}

export class CommandNotFoundError extends Error {
    constructor(command: string) {
        super(`\`${command}\` was not found. Is the .NET SDK installed?`);
        this.name = "CommandNotFoundError";
    }
}

export function abortError(): Error {
    const error = new Error("Scan cancelled.");
    error.name = "AbortError";
    return error;
}

/**
 * A counting semaphore. It limits how many child processes run at once across
 * the whole extension.
 */
export class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private limit: number) { }

    setLimit(limit: number): void {
        this.limit = Math.max(1, Math.floor(limit) || 1);
        this.drain();
    }

    getLimit(): number {
        return this.limit;
    }

    getActive(): number {
        return this.active;
    }

    async acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            throw abortError();
        }
        if (this.active < this.limit) {
            this.active += 1;
            return this.releaser();
        }

        await new Promise<void>((resolve, reject) => {
            const wake = () => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            };
            const onAbort = () => {
                const index = this.waiting.indexOf(wake);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(abortError());
            };
            this.waiting.push(wake);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
        // drain() reserved the slot for this waiter already.
        return this.releaser();
    }

    private releaser(): () => void {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.active -= 1;
            this.drain();
        };
    }

    private drain(): void {
        while (this.active < this.limit && this.waiting.length > 0) {
            const next = this.waiting.shift();
            if (next) {
                // Hand the slot to the waiter before it resumes.
                this.active += 1;
                next();
            }
        }
    }
}

export const processSlots = new Semaphore(4);

const running = new Set<ChildProcess>();

/**
 * Kills a child process and everything it started.
 * On Windows this runs `taskkill /T /F`. Elsewhere the child leads its own
 * process group, and the whole group gets SIGTERM, then SIGKILL.
 */
export function killProcessTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) {
        return;
    }

    if (process.platform === "win32") {
        try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                shell: false,
                windowsHide: true,
                stdio: "ignore",
            });
            killer.on("error", () => child.kill());
        } catch {
            child.kill();
        }
        return;
    }

    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
        try {
            process.kill(-pid, signal);
        } catch {
            try {
                child.kill(signal);
            } catch {
                // The process is gone already.
            }
        }
    };
    signalGroup("SIGTERM");
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            signalGroup("SIGKILL");
        }
    }, 2000);
    timer.unref?.();
}

export function killAllProcesses(): void {
    for (const child of [...running]) {
        killProcessTree(child);
    }
}

/**
 * Runs a program with an argument array. No shell is involved, so no argument
 * is ever parsed as shell syntax. The process tree is killed on abort and on
 * timeout. The global slot limit applies.
 */
export async function runProcess(
    command: string,
    args: readonly string[],
    options: RunOptions
): Promise<RunResult> {
    const release = await processSlots.acquire(options.signal);
    try {
        return await runUnlimited(command, args, options);
    } finally {
        release();
    }
}

function runUnlimited(
    command: string,
    args: readonly string[],
    options: RunOptions
): Promise<RunResult> {
    const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;

    return new Promise<RunResult>((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(abortError());
            return;
        }

        let child: ChildProcess;
        try {
            child = spawn(command, [...args], {
                cwd: options.cwd,
                env: options.env,
                shell: false,
                windowsHide: true,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error: any) {
            reject(error?.code === "ENOENT" ? new CommandNotFoundError(command) : error);
            return;
        }

        running.add(child);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let settled = false;
        let timedOut = false;
        let overflow = false;

        const finish = (action: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            running.delete(child);
            action();
        };

        const onAbort = () => {
            killProcessTree(child);
            finish(() => reject(abortError()));
        };

        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, Math.max(1, options.timeoutMs));

        options.signal?.addEventListener("abort", onAbort, { once: true });

        const collect = (target: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBuffer) {
                if (!overflow) {
                    overflow = true;
                    killProcessTree(child);
                }
                return;
            }
            target.push(chunk);
        };
        child.stdout?.on("data", collect(stdout));
        child.stderr?.on("data", collect(stderr));

        child.on("error", (error: any) => {
            finish(() => reject(error?.code === "ENOENT" ? new CommandNotFoundError(command) : error));
        });

        child.on("close", (code) => {
            const out = Buffer.concat(stdout).toString("utf8");
            const err = Buffer.concat(stderr).toString("utf8");
            finish(() => {
                if (timedOut) {
                    reject(new ProcessError(
                        `${command} ${args[0] ?? ""} timed out after ${Math.round(options.timeoutMs / 1000)} s.`,
                        code,
                        out,
                        err,
                        true
                    ));
                    return;
                }
                if (overflow) {
                    reject(new ProcessError(`${command} ${args[0] ?? ""} wrote more output than PackageHub reads.`, code, out, err));
                    return;
                }
                resolve({ stdout: out, stderr: err, exitCode: code, timedOut: false });
            });
        });
    });
}

/**
 * Picks the lines that explain a failure: MSBuild and NuGet errors first, then
 * any line that says error. At most `limit` lines.
 */
export function errorLines(text: string, limit = 8): string[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const coded = lines.filter((line) => /\berror\s+[A-Z]+\d+\b|\berror:\s/i.test(line));
    const generic = lines.filter((line) => !coded.includes(line) && /\b(error|failed|unable)\b/i.test(line));
    const picked = [...coded, ...generic];
    const unique: string[] = [];
    for (const line of picked) {
        if (!unique.includes(line)) {
            unique.push(line);
        }
    }
    return unique.slice(0, limit);
}
