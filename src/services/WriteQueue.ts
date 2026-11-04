/**
 * Runs write jobs (update, remove, bulk update, restore) one at a time, in the
 * order they were queued.
 */
export class WriteQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private depth = 0;

    get busy(): boolean {
        return this.depth > 0;
    }

    run<T>(job: () => Promise<T>): Promise<T> {
        this.depth += 1;
        const next = this.tail.then(job, job);
        this.tail = next.then(
            () => undefined,
            () => undefined
        ).finally(() => {
            this.depth -= 1;
        });
        return next;
    }
}

/**
 * Calls the action once, `delayMs` after the last trigger.
 */
export class Debouncer<T> {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly pending = new Set<T>();

    constructor(
        private readonly delayMs: number,
        private readonly action: (items: T[]) => void
    ) { }

    trigger(item: T): void {
        this.pending.add(item);
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const items = [...this.pending];
            this.pending.clear();
            this.action(items);
        }, this.delayMs);
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pending.clear();
    }
}
