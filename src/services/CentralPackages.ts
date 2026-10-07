import * as fs from "fs/promises";
import { readPackageRef } from "../utils/nugetAudit";
import { logger } from "../utils/logger";
import { ScanState } from "./ScanState";
import { WorkspaceScanner } from "./WorkspaceScanner";

export interface CentralPackageVersion {
    id: string;
    version: string;
}

export function parseCentralPackages(xml: string): {
    enabled: boolean;
    versions: CentralPackageVersion[];
} {
    const enabled = /<ManagePackageVersionsCentrally>\s*true\s*<\/ManagePackageVersionsCentrally>/i.test(xml);
    const versions: CentralPackageVersion[] = [];

    for (const line of xml.split(/\r?\n/)) {
        const ref = readPackageRef(line);
        if (ref?.kind === "version" && ref.version) {
            versions.push({ id: ref.id, version: ref.version });
        }
    }

    return { enabled, versions };
}

export async function refreshCentralPackages(scanner: WorkspaceScanner): Promise<void> {
    const files = await scanner.findCentralPackageManagementFiles();
    const versions: CentralPackageVersion[] = [];
    let enabled = false;

    for (const file of files) {
        let text = "";
        try {
            text = await fs.readFile(file.fsPath, "utf8");
        } catch (error: any) {
            logger.error(`CPM okunamadı (${file.fsPath}): ${error.message}`);
            continue;
        }

        const parsed = parseCentralPackages(text);
        if (!parsed.enabled) {
            continue;
        }

        enabled = true;
        for (const item of parsed.versions) {
            const known = versions.some((existing) => existing.id.toLowerCase() === item.id.toLowerCase());
            if (!known) {
                versions.push(item);
            }
        }
    }

    ScanState.setCpm(enabled);
    ScanState.setCentralVersions(enabled ? versions : []);
}
