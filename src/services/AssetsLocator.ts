import * as path from "path";
import { assetsFileFromFiles } from "./ProjectEvaluation";

const known = new Map<string, string>();

function key(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

/**
 * Remembers the project.assets.json path MSBuild reported for a project.
 */
export function rememberAssetsFile(projectPath: string, assetsFile: string): void {
    known.set(key(projectPath), assetsFile);
}

export function forgetAssetsFiles(): void {
    known.clear();
}

/**
 * The project.assets.json of a project. Uses the evaluated ProjectAssetsFile
 * when a scan read it, otherwise honours MSBuildProjectExtensionsPath,
 * BaseIntermediateOutputPath and UseArtifactsOutput from the files.
 */
export async function assetsFileFor(projectPath: string): Promise<string> {
    return known.get(key(projectPath)) ?? assetsFileFromFiles(projectPath);
}
