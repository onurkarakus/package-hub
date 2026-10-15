import * as path from "path";

export function isMsBuildProject(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".csproj") || lower.endsWith(".fsproj");
}

export function isPackageDocumentPath(filePath: string): boolean {
    return isMsBuildProject(filePath) || filePath.toLowerCase().endsWith(".props");
}

export function projectNameFromPath(filePath: string): string {
    return path.basename(filePath).replace(/\.(csproj|fsproj)$/i, "");
}
