import { l10n } from "vscode";
import { PackageEntry } from "../models/PackageInfo";
import { compareNuGetVersions, parseNuGetVersion } from "../utils/nugetAudit";
import { readVersionSpec } from "./VersionSpec";

/**
 * Plans how to bring one package to the same version in every project.
 *
 * - Only direct references move. Transitive versions follow their parents.
 * - Projects are grouped by major version. Each group moves to the highest
 *   version already used in that group, so nothing crosses a major version
 *   and nothing is downgraded.
 * - A project that uses different versions per target framework keeps them:
 *   that split is usually on purpose.
 * - A range or floating version is left alone; the update rules for ranges
 *   apply when you update the package itself.
 */

export interface AlignMove {
    projectName: string;
    projectPath: string;
    from: string;
}

export interface AlignKept {
    projectName: string;
    reason: string;
}

export interface AlignPlan {
    packageId: string;
    major: number;
    target: string;
    moves: AlignMove[];
    /** Projects already at the target. */
    aligned: string[];
    kept: AlignKept[];
}

interface ProjectVersion {
    projectName: string;
    projectPath: string;
    version: string;
}

export function planAlignment(packageId: string, entries: PackageEntry[]): AlignPlan[] {
    const id = packageId.toLowerCase();
    const byProject = new Map<string, PackageEntry[]>();
    for (const entry of entries) {
        if (entry.isTransitive || entry.id.toLowerCase() !== id) {
            continue;
        }
        const key = (entry.projectPath || entry.projectName).toLowerCase();
        const list = byProject.get(key) ?? [];
        list.push(entry);
        byProject.set(key, list);
    }

    const kept: AlignKept[] = [];
    const usable: ProjectVersion[] = [];
    for (const list of byProject.values()) {
        const first = list[0];
        const versions = [...new Set(list.map((entry) => entry.resolvedVersion || entry.requestedVersion || "").filter(Boolean))];
        const distinct = versions.filter((version, index) =>
            versions.findIndex((other) => compareNuGetVersions(other, version) === 0 || other === version) === index);
        if (distinct.length !== 1) {
            kept.push({
                projectName: first.projectName,
                reason: distinct.length > 1
                    ? l10n.t("uses {0} for different target frameworks, kept as is", distinct.join(" / "))
                    : l10n.t("no version was read"),
            });
            continue;
        }
        const requested = list.find((entry) => entry.requestedVersion)?.requestedVersion;
        const spec = readVersionSpec(requested);
        if (requested && (spec.kind === "range" || spec.kind === "floating" || spec.kind === "unknown")) {
            kept.push({ projectName: first.projectName, reason: l10n.t("asks for {0}, kept as is", requested) });
            continue;
        }
        if (!parseNuGetVersion(distinct[0])) {
            kept.push({ projectName: first.projectName, reason: l10n.t("{0} is not an exact version", distinct[0]) });
            continue;
        }
        usable.push({ projectName: first.projectName, projectPath: first.projectPath, version: distinct[0] });
    }

    const byMajor = new Map<number, ProjectVersion[]>();
    for (const item of usable) {
        const major = parseNuGetVersion(item.version)!.release[0];
        const list = byMajor.get(major) ?? [];
        list.push(item);
        byMajor.set(major, list);
    }

    const plans: AlignPlan[] = [];
    for (const [major, list] of byMajor) {
        const target = list.reduce((best, item) => compareNuGetVersions(item.version, best) > 0 ? item.version : best, list[0].version);
        const moves = list
            .filter((item) => compareNuGetVersions(item.version, target) < 0)
            .map((item) => ({ projectName: item.projectName, projectPath: item.projectPath, from: item.version }))
            .sort((left, right) => left.projectName.localeCompare(right.projectName));
        const aligned = list
            .filter((item) => compareNuGetVersions(item.version, target) === 0)
            .map((item) => item.projectName)
            .sort((left, right) => left.localeCompare(right));
        if (moves.length === 0) {
            continue;
        }
        plans.push({ packageId, major, target, moves, aligned, kept: [...kept] });
    }
    return plans.sort((left, right) => right.major - left.major);
}

/**
 * Package ids that have at least one alignment plan.
 */
export function alignablePackages(entries: PackageEntry[]): string[] {
    const ids = new Map<string, string>();
    for (const entry of entries) {
        if (!entry.isTransitive) {
            ids.set(entry.id.toLowerCase(), entry.id);
        }
    }
    return [...ids.values()]
        .filter((id) => planAlignment(id, entries).length > 0)
        .sort((left, right) => left.localeCompare(right));
}
