import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "./ScanState";

const LAST_SCAN_KEY = "packageHub.lastScan";

interface LastScanRecord {
    vulnerable: PackageInfo[];
    outdated: PackageInfo[];
    deprecated: PackageInfo[];
    scannedAt: string;
    hasCpm: boolean;
}

export async function saveLastScan(state: vscode.Memento): Promise<void> {
    const scannedAt = ScanState.getScannedAt();
    if (!scannedAt) {
        return;
    }

    const record: LastScanRecord = {
        vulnerable: ScanState.getVulnerable(),
        outdated: ScanState.getOutDated(),
        deprecated: ScanState.getDeprecated(),
        scannedAt: scannedAt.toISOString(),
        hasCpm: ScanState.getCpm(),
    };

    await state.update(LAST_SCAN_KEY, record);
}

export function restoreLastScan(state: vscode.Memento): boolean {
    const record = state.get<Partial<LastScanRecord>>(LAST_SCAN_KEY);
    if (!record) {
        return false;
    }

    const scannedAt = new Date(record.scannedAt || "");
    const vulnerable = readPackages(record.vulnerable);
    const outdated = readPackages(record.outdated);
    const deprecated = readPackages(record.deprecated);

    if (Number.isNaN(scannedAt.getTime()) || !vulnerable || !outdated || !deprecated) {
        return false;
    }

    ScanState.setResults(vulnerable, outdated, deprecated, scannedAt);
    ScanState.setCpm(record.hasCpm === true);
    return true;
}

function readPackages(value: unknown): PackageInfo[] | undefined {
    if (!Array.isArray(value) || value.some((item) => !isPackageInfo(item))) {
        return undefined;
    }

    return value;
}

function isPackageInfo(value: unknown): value is PackageInfo {
    if (!value || typeof value !== "object") {
        return false;
    }

    const item = value as PackageInfo;
    return typeof item.id === "string"
        && typeof item.version === "string"
        && Array.isArray(item.projects);
}
