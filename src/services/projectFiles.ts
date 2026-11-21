import * as path from "path";

/** Project file extensions PackageHub reads: C#, F# and Visual Basic. */
export const PROJECT_EXTENSIONS = ["csproj", "fsproj", "vbproj"] as const;

/** Glob for every project file PackageHub reads. */
export const PROJECT_GLOB = `**/*.{${PROJECT_EXTENSIONS.join(",")}}`;

/** Glob for project files and props files: the files with package lines. */
export const PACKAGE_DOCUMENT_GLOB = `**/*.{${PROJECT_EXTENSIONS.join(",")},props}`;

export function isMsBuildProject(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return PROJECT_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}

export function isPackageDocumentPath(filePath: string): boolean {
    return isMsBuildProject(filePath) || filePath.toLowerCase().endsWith(".props");
}

export function isSolutionPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".sln") || lower.endsWith(".slnx");
}

export function projectNameFromPath(filePath: string): string {
    return path.basename(filePath).replace(/\.(csproj|fsproj|vbproj)$/i, "");
}
