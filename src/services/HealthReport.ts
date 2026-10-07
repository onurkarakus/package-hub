import { PackageInfo } from "../models/PackageInfo";
import { ScanState } from "./ScanState";

export function buildHealthReport(): string | undefined {
    const scannedAt = ScanState.getScannedAt();
    if (!scannedAt) {
        return undefined;
    }

    const vulnerable = [...ScanState.getVulnerable()].sort(byId);
    const outdated = [...ScanState.getOutDated()].sort(byId);
    const deprecated = [...ScanState.getDeprecated()].sort(byId);
    const conflicts = [...ScanState.getVersionConflicts()].sort((left, right) =>
        left.id.localeCompare(right.id)
    );

    const counts = table(
        ["Kind", "Count"],
        [
            ["Vulnerable", String(vulnerable.length)],
            ["Outdated", String(outdated.length)],
            ["Deprecated", String(deprecated.length)],
            ["Conflicts", String(conflicts.length)],
        ]
    );

    const sections = [
        "# PackageHub health report",
        "",
        `Last scanned: ${scannedAt.toLocaleString()}`,
        "",
        counts,
        "",
        "## Vulnerable",
        "",
        vulnerable.length === 0
            ? "None."
            : table(
                ["Package", "Version", "Severity", "Advisory", "Projects"],
                vulnerable.map((pkg) => [
                    pkg.id,
                    pkg.version,
                    pkg.severity || "",
                    pkg.advisoryUrl || "",
                    projectsOf(pkg),
                ])
            ),
        "",
        "## Outdated",
        "",
        outdated.length === 0
            ? "None."
            : table(
                ["Package", "Version", "Latest", "Projects"],
                outdated.map((pkg) => [
                    pkg.id,
                    pkg.version,
                    pkg.latestVersion || "",
                    projectsOf(pkg),
                ])
            ),
        "",
        "## Deprecated",
        "",
        deprecated.length === 0
            ? "None."
            : table(
                ["Package", "Version", "Projects"],
                deprecated.map((pkg) => [pkg.id, pkg.version, projectsOf(pkg)])
            ),
        "",
        "## Conflicts",
        "",
        conflicts.length === 0
            ? "None."
            : table(
                ["Package", "Versions"],
                conflicts.map((conflict) => [
                    conflict.id,
                    conflict.versions
                        .map((entry) => `${entry.version} (${entry.projects.join(", ")})`)
                        .join(" / "),
                ])
            ),
        "",
    ];

    return sections.join("\n");
}

function byId(left: PackageInfo, right: PackageInfo): number {
    return left.id.localeCompare(right.id);
}

function projectsOf(pkg: PackageInfo): string {
    return (pkg.projects || []).join(", ");
}

function table(headers: string[], rows: string[][]): string {
    const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
    return [
        line(headers),
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map(line),
    ].join("\n");
}

function cell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
