import * as vscode from "vscode";
import * as path from "path";
import { logger } from "../utils/logger";

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
        return this.find("**/*.{csproj}", "Projeler okunamadı");
    }

    /**
   * Tüm .sln dosyalarını bulur
   */
    async findSolutions(): Promise<vscode.Uri[]> {
        return this.find("**/*.{sln,slnx}", "Solution dosyaları okunamadı");
    }

    /**
     * Central Package Management dosyalarını bulur
     * (Directory.Packages.props)
     */
    async findCentralPackageManagementFiles(): Promise<vscode.Uri[]> {
        return this.find("**/Directory.Packages.props", "CPM dosyaları okunamadı");
    }

    /**
     * NuGet.config dosyalarını bulur (hierarchical destek için)
     */
    async findNuGetConfigs(): Promise<vscode.Uri[]> {
        return this.find("**/{NuGet.config,nuget.config,NuGet.Config}", "NuGet.config okunamadı");
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
     * Proje adını dosya yolundan çıkarır
     * Örnek: /src/MyApi/MyApi.csproj → MyApi
     */
    getProjectName(projectUri: vscode.Uri): string {
        return path.basename(projectUri.fsPath, ".csproj");
    }
}
