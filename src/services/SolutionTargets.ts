import * as fs from "fs/promises";
import * as path from "path";

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
        if (!relative.toLowerCase().endsWith(".csproj")) {
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
