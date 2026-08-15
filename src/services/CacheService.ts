import { encapsulate } from "crypto";

export class CacheService {

    private cache = new Map<string, { data: any; timestamp: number }>();

    get<T>(key: string, maxAgeMs: number = 5 * 60 * 1000): T | undefined {

        const entry = this.cache.get(key);

        if (!entry) {
            return undefined;
        }

        const isExpired = Date.now() - entry.timestamp > maxAgeMs;

        if (isExpired) {
            this.cache.delete(key);

            return undefined;
        }

        return entry.data as T;
    }

    set(key: string, data: any): void {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    invalidate(key: string) {
        this.cache.delete(key);
    }

    invalidateAll(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}