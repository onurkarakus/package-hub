import * as fs from "fs/promises";
import { maskXmlComments, readPackageRefs } from "../utils/nugetAudit";
import { logger } from "../utils/logger";
import { ProjectEvaluation, readXmlProperty } from "./ProjectEvaluation";
import { ScanState } from "./ScanState";
import { WorkspaceScanner } from "./WorkspaceScanner";

export interface CentralPackageVersion {
    id: string;
    version: string;
}

export function parseCentralPackages(xml: string): {
    enabled: boolean;
    versions: CentralPackageVersion[];
    globals: CentralPackageVersion[];
} {
    const enabled = (readXmlProperty(maskXmlComments(xml), "ManagePackageVersionsCentrally") || "").toLowerCase() === "true";
    const versions: CentralPackageVersion[] = [];
    const globals: CentralPackageVersion[] = [];

    for (const ref of readPackageRefs(xml)) {
        if (ref.tag === "PackageVersion" && ref.declaredVersion) {
            versions.push({ id: ref.id, version: ref.declaredVersion });
        } else if (ref.tag === "GlobalPackageReference" && ref.declaredVersion) {
            globals.push({ id: ref.id, version: ref.declaredVersion });
        }
    }

    return { enabled, versions, globals };
}

function addUnique(list: CentralPackageVersion[], item: CentralPackageVersion): void {
    if (!list.some((existing) => existing.id.toLowerCase() === item.id.toLowerCase())) {
        list.push(item);
    }
}

/**
 * Reads CPM state. With MSBuild evaluations from a scan, CPM is on when MSBuild
 * says so for any project, wherever the property is set. Without them, the
 * property is read from Directory.Packages.props, Directory.Build.props and the
 * project files.
 */
export async function refreshCentralPackages(
    scanner: WorkspaceScanner,
    evaluations: ProjectEvaluation[] = []
): Promise<void> {
    const versions: CentralPackageVersion[] = [];
    let enabled = false;

    if (evaluations.length > 0) {
        for (const evaluation of evaluations) {
            if (!evaluation.cpmEnabled) {
                continue;
            }
            enabled = true;
            for (const item of evaluation.packageVersions) {
                if (item.version) {
                    addUnique(versions, { id: item.id, version: item.version });
                }
            }
        }
        // GlobalPackageReference versions are read from the props files below.
    }

    const files = await scanner.findCentralPackageManagementFiles();
    let enabledOutside = false;
    if (!enabled && evaluations.length === 0) {
        enabledOutside = await cpmEnabledOutsideProps(scanner);
    }

    for (const file of files) {
        let text = "";
        try {
            text = await fs.readFile(file.fsPath, "utf8");
        } catch (error: any) {
            logger.error(`Could not read CPM (${file.fsPath}): ${error.message}`);
            continue;
        }

        const parsed = parseCentralPackages(text);
        const fileEnabled = evaluations.length > 0 ? enabled : parsed.enabled || enabledOutside;
        if (!fileEnabled) {
            continue;
        }

        enabled = true;
        for (const item of parsed.versions) {
            addUnique(versions, item);
        }
    }

    ScanState.setCpm(enabled);
    ScanState.setCentralVersions(enabled ? versions : []);
}

async function cpmEnabledOutsideProps(scanner: WorkspaceScanner): Promise<boolean> {
    const candidates = [
        ...(await scanner.findBuildPropsFiles()),
        ...(await scanner.findProjects()),
    ];
    for (const file of candidates) {
        try {
            const text = await fs.readFile(file.fsPath, "utf8");
            if ((readXmlProperty(text, "ManagePackageVersionsCentrally") || "").toLowerCase() === "true") {
                return true;
            }
        } catch {
            continue;
        }
    }
    return false;
}
