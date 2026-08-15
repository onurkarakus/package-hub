import * as vscode from "vscode";
import * as path from "path";

export class WorkspaceScanner {
    /**
   * Workspace kök klasörünü döner.
   * Multi-root workspace'te ilk klasörü alır (şimdilik yeterli).
   */
    getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;

        if (!folders || folders.length === 0) {
            return undefined;
        }

        return folders[0].uri.fsPath;
    }

    /**
   * Tüm .csproj dosyalarını bulur
   */
    async findProjects(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            "**/*.{csproj}",
            "**/{node_modules,bin,obj,.git}/**"
        );
    }

    /**
   * Tüm .sln dosyalarını bulur
   */
    async findSolutions(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            "**/*.{sln}",
            "**/{node_modules,bin,obj,.git}/**"
        );
    }

    /**
     * Central Package Management dosyalarını bulur
     * (Directory.Packages.props)
     */
    async findCentralPackageManagementFiles(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            "**/Directory.Packages.props",
            "**/{node_modules,bin,obj,.git}/**"
        );
    }

    /**
     * NuGet.config dosyalarını bulur (hierarchical destek için)
     */
    async findNuGetConfigs(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            "**/NuGet.config",
            "**/{node_modules,bin,obj,.git}/**"
        );
    }

    /**
     * Proje adını dosya yolundan çıkarır
     * Örnek: /src/MyApi/MyApi.csproj → MyApi
     */
    getProjectName(projectUri: vscode.Uri): string {
        return path.basename(projectUri.fsPath, ".csproj");
    }
}
