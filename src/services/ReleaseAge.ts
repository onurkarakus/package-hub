import * as vscode from "vscode";
import { ScanState } from "./ScanState";
import { logger } from "../utils/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
const published = new Map<string, Date | null>();

export function publishedAt(packageId: string, version: string): Date | undefined {
    const value = published.get(ageKey(packageId, version));
    return value instanceof Date ? value : undefined;
}

export function releaseIsMature(
    publishedOn: Date | undefined,
    minimumDays: number,
    now = Date.now()
): boolean {
    if (typeof minimumDays !== "number" || !Number.isFinite(minimumDays) || minimumDays <= 0) {
        return true;
    }
    if (!publishedOn || Number.isNaN(publishedOn.getTime())) {
        return true;
    }
    return publishedOn.getTime() <= now - minimumDays * DAY_MS;
}

export function latestReleasePreferred(packageId: string, version: string): boolean {
    const days = vscode.workspace.getConfiguration("packageHub").get<number>("minimumReleaseAge");
    return releaseIsMature(publishedAt(packageId, version), typeof days === "number" ? days : 0);
}

export async function loadReleaseAges(): Promise<void> {
    const targets = releaseTargets();
    if (targets.length === 0) {
        logger.info("Release-age record is ready.");
        return;
    }

    let ready = 0;
    let firstError = "";
    for (let index = 0; index < targets.length; index += 4) {
        const batch = targets.slice(index, index + 4);
        const results = await Promise.all(batch.map((target) => loadOne(target)));
        for (const result of results) {
            if (result.ok) {
                ready += 1;
            } else if (!firstError && result.error) {
                firstError = result.error;
            }
        }
    }

    if (ready === 0) {
        throw new Error(firstError || "Could not read the latest publish date.");
    }

    logger.info("Release-age record is ready.");
}

function releaseTargets(): { id: string; version: string }[] {
    const found = new Map<string, { id: string; version: string }>();
    for (const pkg of [...ScanState.getAllVulnerable(), ...ScanState.getOutDated()]) {
        if (!pkg.id || !pkg.latestVersion) {
            continue;
        }
        const key = ageKey(pkg.id, pkg.latestVersion);
        if (!found.has(key)) {
            found.set(key, { id: pkg.id, version: pkg.latestVersion });
        }
    }
    return [...found.values()];
}

async function loadOne(
    target: { id: string; version: string }
): Promise<{ ok: boolean; error?: string }> {
    const key = ageKey(target.id, target.version);
    try {
        const data = await fetchJson(leafUrl(target.id, target.version));
        published.set(key, readPublished(data?.published) || null);
        return { ok: true };
    } catch (error: any) {
        published.set(key, null);
        return { ok: false, error: error?.message || String(error) };
    }
}

function readPublished(value: unknown): Date | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
        return undefined;
    }
    return date;
}

function leafUrl(packageId: string, version: string): string {
    const id = encodeURIComponent(packageId.trim().toLowerCase());
    const ver = encodeURIComponent(version.trim().toLowerCase());
    return `https://api.nuget.org/v3/registration5-gz-semver2/${id}/${ver}.json`;
}

function ageKey(packageId: string, version: string): string {
    return `${packageId.trim().toLowerCase()}\n${version.trim().toLowerCase()}`;
}

async function fetchJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`${response.status} ${url}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}
