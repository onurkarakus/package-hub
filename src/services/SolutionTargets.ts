import * as fs from "fs/promises";
import * as path from "path";
import { isMsBuildProject } from "./projectFiles";

const projectLine =
    /^Project\("\{[^"]+\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"\{[^"]+\}"\s*$/;

export interface SolutionProjects {
    solutionPath: string;
    projects: string[];
    error?: string;
}

export function classicSolutionPaths(paths: string[]): string[] {
    return paths.filter((item) => item.toLowerCase().endsWith(".sln"));
}

export function slnxPaths(paths: string[]): string[] {
    return paths.filter((item) => item.toLowerCase().endsWith(".slnx"));
}

export function csprojPathsInSolution(solutionText: string, solutionPath: string): string[] {
    const directory = path.dirname(solutionPath);
    const found: string[] = [];

    for (const line of solutionText.split(/\r?\n/)) {
        const match = projectLine.exec(line.trim());
        if (!match) {
            continue;
        }

        const relative = match[1].replace(/\\/g, "/");
        if (!isMsBuildProject(relative)) {
            continue;
        }

        const absolute = path.resolve(directory, relative);
        if (!found.some((item) => samePath(item, absolute))) {
            found.push(absolute);
        }
    }

    return found;
}

export function restoreTargetsForProjects(
    solutions: SolutionProjects[],
    projectPaths: string[]
): string[] {
    const targets: string[] = [];
    const add = (target: string) => {
        if (!targets.some((item) => samePath(item, target))) {
            targets.push(target);
        }
    };

    for (const projectPath of projectPaths) {
        const owners = solutions.filter((solution) =>
            solution.projects.some((item) => samePath(item, projectPath))
        );
        if (owners.length === 0) {
            add(projectPath);
            continue;
        }

        for (const owner of owners) {
            add(owner.solutionPath);
        }
    }

    return targets;
}

export async function readSolutionProjects(solutionPaths: string[]): Promise<SolutionProjects[]> {
    const result: SolutionProjects[] = [];

    for (const solutionPath of solutionPaths) {
        try {
            const text = await fs.readFile(solutionPath, "utf8");
            result.push({
                solutionPath,
                projects: csprojPathsInSolution(text, solutionPath),
            });
        } catch (error: any) {
            result.push({
                solutionPath,
                projects: [],
                error: error?.message || String(error),
            });
        }
    }

    return result;
}

function samePath(left: string, right: string): boolean {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    if (process.platform === "win32" || process.platform === "darwin") {
        return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
    }

    return resolvedLeft === resolvedRight;
}

export interface ScanPlan {
    /** Solutions to scan, without the ones whose projects are all covered by an earlier solution. */
    solutions: string[];
    /** Projects that belong to no scanned solution. They are scanned one by one. */
    projects: string[];
    /** Solutions left out because another solution already covers every project. */
    skippedSolutions: string[];
}

/**
 * Decides what to scan: every classic solution that adds at least one project,
 * then every project that no solution covers. A project shared by overlapping
 * solutions is scanned with the first one only (later duplicates are dropped
 * when results are merged).
 */
export function planScanTargets(solutions: SolutionProjects[], projectPaths: string[]): ScanPlan {
    const covered: string[] = [];
    const plan: ScanPlan = { solutions: [], projects: [], skippedSolutions: [] };
    const ordered = [...solutions].sort((left, right) =>
        right.projects.length - left.projects.length || left.solutionPath.localeCompare(right.solutionPath)
    );

    for (const solution of ordered) {
        if (solution.error) {
            continue;
        }
        const adds = solution.projects.some((project) => !covered.some((item) => samePath(item, project)));
        if (!adds && solution.projects.length > 0) {
            plan.skippedSolutions.push(solution.solutionPath);
            continue;
        }
        plan.solutions.push(solution.solutionPath);
        for (const project of solution.projects) {
            if (!covered.some((item) => samePath(item, project))) {
                covered.push(project);
            }
        }
    }

    for (const projectPath of projectPaths) {
        if (!covered.some((item) => samePath(item, projectPath))
            && !plan.projects.some((item) => samePath(item, projectPath))) {
            plan.projects.push(projectPath);
        }
    }

    return plan;
}
