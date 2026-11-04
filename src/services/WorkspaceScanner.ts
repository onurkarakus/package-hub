import * as vscode from "vscode";
import { projectNameFromPath } from "./projectFiles";
import { classicSolutionPaths } from "./SolutionTargets";
import { logger } from "../utils/logger";

export class WorkspaceScanner {
    private readonly cache = new Map<string, Promise<vscode.Uri[]>>();

    /**
     * Drops the cached file lists. Called when a project, solution, props or
     * NuGet.config file is created or deleted, and at the start of a scan.
     */
    invalidate(): void {
        this.cache.clear();
    }

    /**
     * Keeps the cache in step with the workspace.
     */
    watch(): vscode.Disposable {
        const watcher = vscode.workspace.createFileSystemWatcher(
            "**/{*.csproj,*.fsproj,*.sln,*.slnx,*.props,NuGet.config,nuget.config,NuGet.Config}",
            false,
            true,
            false
        );
        watcher.onDidCreate(() => this.invalidate());
        watcher.onDidDelete(() => this.invalidate());
        return watcher;
    }

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
     * Finds Directory.Build.props files.
     */
    async findBuildPropsFiles(): Promise<vscode.Uri[]> {
        return this.find("**/Directory.Build.props", "Could not read Directory.Build.props files");
    }

    /**
     * Finds NuGet.config files, including nested ones.
     */
    async findNuGetConfigs(): Promise<vscode.Uri[]> {
        return this.find("**/{NuGet.config,nuget.config,NuGet.Config}", "Could not read NuGet.config");
    }

    private find(pattern: string, failure: string): Promise<vscode.Uri[]> {
        const cached = this.cache.get(pattern);
        if (cached) {
            return cached.then((items) => [...items]);
        }
        const job = this.findUncached(pattern, failure);
        this.cache.set(pattern, job);
        return job.then((items) => [...items]);
    }

    private async findUncached(pattern: string, failure: string): Promise<vscode.Uri[]> {
        try {
            return await vscode.workspace.findFiles(
                pattern,
                "**/{node_modules,bin,obj,.git}/**"
            );
        } catch (error: any) {
            logger.error(`${failure}: ${error?.message || error}`);
            this.cache.delete(pattern);
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
