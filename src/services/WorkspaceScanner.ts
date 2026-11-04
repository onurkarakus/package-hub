import * as vscode from "vscode";
import { projectNameFromPath } from "./projectFiles";
import { classicSolutionPaths } from "./SolutionTargets";
import { logger } from "../utils/logger";

export class WorkspaceScanner {
    /**
   * Returns the workspace root folder.
   * In a multi-root workspace, uses the first folder.
   */
    getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;

        if (!folders || folders.length === 0) {
            return undefined;
        }

        return folders[0].uri.fsPath;
    }

    /**
   * Finds every C# and F# project file.
   */
    async findProjects(): Promise<vscode.Uri[]> {
        return this.find("**/*.{csproj,fsproj}", "Could not read projects");
    }

    /**
     * Counts what a scan can read: C# and F# projects plus classic .sln files.
     * A .sln can point at projects outside the workspace, so it counts on its own.
     */
    async countScanTargets(): Promise<{ projects: vscode.Uri[]; targets: number }> {
        const [projects, solutions] = await Promise.all([this.findProjects(), this.findSolutions()]);
        return {
            projects,
            targets: projects.length + classicSolutionPaths(solutions.map((item) => item.fsPath)).length,
        };
    }

    /**
   * Finds every .sln file.
   */
    async findSolutions(): Promise<vscode.Uri[]> {
        return this.find("**/*.{sln,slnx}", "Could not read solution files");
    }

    /**
     * Finds Central Package Management files
     * (Directory.Packages.props).
     */
    async findCentralPackageManagementFiles(): Promise<vscode.Uri[]> {
        return this.find("**/Directory.Packages.props", "Could not read CPM files");
    }

    /**
     * Finds NuGet.config files, including nested ones.
     */
    async findNuGetConfigs(): Promise<vscode.Uri[]> {
        return this.find("**/{NuGet.config,nuget.config,NuGet.Config}", "Could not read NuGet.config");
    }

    private async find(pattern: string, failure: string): Promise<vscode.Uri[]> {
        try {
            return await vscode.workspace.findFiles(
                pattern,
                "**/{node_modules,bin,obj,.git}/**"
            );
        } catch (error: any) {
            logger.error(`${failure}: ${error?.message || error}`);
            return [];
        }
    }

    /**
     * Reads the project name from the file path.
     * Example: /src/MyApi/MyApi.csproj → MyApi
     */
    getProjectName(projectUri: vscode.Uri): string {
        return projectNameFromPath(projectUri.fsPath);
    }
}
