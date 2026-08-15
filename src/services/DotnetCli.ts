import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { pbkdf2 } from "crypto";

const execAsync = promisify(exec);

export class DotnetCli {

    private async run(
        command: string,
        cwd: string,
        timeoutMs: number = 60000
    ): Promise<string> {
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 2014,
            });

            if (stderr && !stdout) {
                throw new Error(stderr);
            }

            return stdout.trim();
        } catch (error: any) {
            if (error.code === "ENOENT") {
                throw new Error("`dotnet`komutu bulunamadı. .NET SDK'nın yüklü olduğundan emin ol.");
            };
            throw new Error(`Dotnet komutu başarısız : ${error.message}`);
        }
    }

    /**
   * Vulnerable paketleri listeler
   * Komut: dotnet list package --vulnerable --include-transitive --format json
   */
    async listVulnerable(
        targetPath: string,
        includeTransitive: boolean = true
    ): Promise<PackageInfo[]> {
        const transitiveFlag = includeTransitive ? "--include-transitive" : "";
        const command = `dotnet list ${targetPath} package --vulnerable ${transitiveFlag} --format json`;

        const cwd = require("path").dirname(targetPath);
        const output = await this.run(command, cwd);
        return this.parsePackageList(output, "vulnerable");
    }

    /**
   * Outdated paketleri listeler
   * Komut: dotnet list package --outdated --include-transitive --format json
   */
    async listOutdated(
        targetPath: string,
        includeTransitive: boolean = true
    ): Promise<PackageInfo[]> {

        const transitiveFlag = includeTransitive ? "--include-transitive" : "";
        const command = `dotnet list ${targetPath} package --outdated ${transitiveFlag} --format json`;

        const cwd = require("path").dirname(targetPath);
        const output = await this.run(command, cwd);
        return this.parsePackageList(output, "outdated");
    }

    /**
   * Deprecated paketleri listeler
   */
    async listDeprecated(workspaceRoot: string): Promise<PackageInfo[]> {
        const command = `dotnet list package --deprecated --format json`;
        const output = await this.run(command, workspaceRoot);

        return this.parsePackageList(output, "deprecated");
    }

    /**
   * Restore çalıştırır
   */
    async restore(workspaceRoot: string): Promise<void> {
        await this.run("dotnet resetore", workspaceRoot);
    }

    /**
   * Belirli bir paketi günceller
   */
    async updatePackage(
        projectPath: string,
        packageId: string,
        version?: string
    ): Promise<void> {
        const versionFlag = version ? `--version ${version}` : "";
        const command = `dotnet add "${projectPath}" package ${packageId} ${versionFlag}`;

        await this.run(command, vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath))?.uri.fsPath || process.cwd());
    }

    /**
   * dotnet list package --format json çıktısını PackageInfo[] dizisine çevirir
   * Not: Microsoft zaman zaman JSON formatını değiştirebiliyor.
   * Bu parser şu anki (2025-2026) formata göre yazıldı.
   */
    private parsePackageList(
        jsonOutput: string,
        type: "vulnerable" | "outdated" | "deprecated"
    ): PackageInfo[] {
        if (!jsonOutput) {
            return [];
        }

        try {
            const data = JSON.parse(jsonOutput);
            const packages: PackageInfo[] = [];

            const projects = data.projects || [];

            for (const project of projects) {

                const projectPath = project.path || project.projectPath || "";
                const projectName = projectPath.split(/[\\/]/).pop()?.replace(".csproj", "") || "Unknown";

                const frameworks = project.frameworks || [];

                for (const framework of frameworks) {
                    const topLevel = framework.topLevelPackages || [];
                    const transitive = framework.transitivePackage || [];

                    const all = [
                        ...topLevel.map((p: any) => ({ ...p, isTransitive: false })),
                        ...transitive.map((p: any) => ({ ...p, isTransitive: true }))
                    ];

                    for (const pkg of all) {

                        const id = pkg.id || pkg.name;
                        const version = pkg.requestedVersion || pkg.resolvedVersion || pkg.version;

                        if (!id || !version) continue;

                        packages.push({
                            id,
                            version,
                            latestVersion: pkg.latestVersion,
                            isVulnerable: type === "vulnerable",
                            isOutdated: type === "outdated",
                            isDeprecated: type === "deprecated",
                            severity: pkg.severity,
                            advisoryUrl: pkg.advisoryUrl || pkg.vulnerabilityUrl,
                            projects: [projectName],
                            isTransitive: pkg.isTransitive
                        });
                    }
                }
            }

            return packages;
        } catch (error) {
            console.error("JSON parse hatası:", error);
            return [];
        }
    }
}