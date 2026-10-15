import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "./ScanState";
import { logger } from "../utils/logger";

const LAST_SCAN_KEY = "packageHub.lastScan";

interface LastScanRecord {
    vulnerable: PackageInfo[];
    outdated: PackageInfo[];
    deprecated: PackageInfo[];
    installed?: PackageInfo[];
    provenProjects?: string[];
    scannedAt: string;
    hasCpm: boolean;
}

export async function saveLastScan(state: vscode.Memento): Promise<void> {
    const scannedAt = ScanState.getScannedAt();
    if (!scannedAt) {
        return;
    }

    const record: LastScanRecord = {
        vulnerable: ScanState.getAllVulnerable(),
        outdated: ScanState.getOutDated(),
        deprecated: ScanState.getDeprecated(),
        installed: ScanState.getInstalled(),
        provenProjects: ScanState.getProvenProjects(),
        scannedAt: scannedAt.toISOString(),
        hasCpm: ScanState.getCpm(),
    };

    try {
        await state.update(LAST_SCAN_KEY, record);
    } catch (error: any) {
        logger.error(`Could not write the last scan: ${error?.message || error}`);
    }
}

export function restoreLastScan(state: vscode.Memento): boolean {
    let record: Partial<LastScanRecord> | undefined;
    try {
        record = state.get<Partial<LastScanRecord>>(LAST_SCAN_KEY);
    } catch (error: any) {
        logger.error(`Could not read the last scan: ${error?.message || error}`);
        return false;
    }
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

    ScanState.setResults(
        vulnerable,
        outdated,
        deprecated,
        scannedAt,
        readOptionalPackages(record.installed),
        readProjectNames(record.provenProjects)
    );
    ScanState.setCpm(record.hasCpm === true);
    return true;
}

function readOptionalPackages(value: unknown): PackageInfo[] {
    if (value === undefined) {
        return [];
    }

    return readPackages(value) || [];
}

function readProjectNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return [];
    }

    return value;
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
