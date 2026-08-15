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
                maxBuffer: 10 * 1024 * 1024,
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
        await this.run("dotnet restore", workspaceRoot);
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

        const severityOrder = ["Critical", "High", "Moderate", "Low"];

        if (!jsonOutput) {
            return [];
        }

        try {
            const data = JSON.parse(jsonOutput);
            const packageMap = new Map<string, PackageInfo>(); // duplicate engellemek için

            const projects = data.projects || [];

            for (const project of projects) {
                const projectPath = project.path || project.projectPath || "";
                const projectName =
                    projectPath.split(/[\\/]/).pop()?.replace(".csproj", "") || "Unknown";

                const frameworks = project.frameworks || [];

                for (const framework of frameworks) {
                    const topLevel = framework.topLevelPackages || [];
                    const transitive = framework.transitivePackages || []; // ← düzeltildi

                    const all = [
                        ...topLevel.map((p: any) => ({ ...p, isTransitive: false })),
                        ...transitive.map((p: any) => ({ ...p, isTransitive: true })),
                    ];

                    for (const pkg of all) {
                        const id = pkg.id || pkg.name;
                        const version =
                            pkg.requestedVersion || pkg.resolvedVersion || pkg.version;

                        if (!id || !version) continue;

                        // Vulnerability bilgisini çıkar
                        let severity: "Critical" | "High" | "Moderate" | "Low" | undefined;
                        let advisoryUrl: string | undefined;

                        if (pkg.vulnerabilities && Array.isArray(pkg.vulnerabilities) && pkg.vulnerabilities.length > 0) {
                            const severityOrder = ["Critical", "High", "Moderate", "Low"] as const;

                            const sorted = [...pkg.vulnerabilities].sort(
                                (a: any, b: any) =>
                                    severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
                            );

                            const rawSeverity = sorted[0].severity;
                            if (severityOrder.includes(rawSeverity)) {
                                severity = rawSeverity as "Critical" | "High" | "Moderate" | "Low";
                            }

                            advisoryUrl =
                                sorted[0].advisoryurl ||
                                sorted[0].advisoryUrl ||
                                sorted[0].url;
                        } else {
                            const raw = pkg.severity;
                            if (raw === "Critical" || raw === "High" || raw === "Moderate" || raw === "Low") {
                                severity = raw;
                            }
                            advisoryUrl = pkg.advisoryUrl || pkg.vulnerabilityUrl || pkg.advisoryurl;
                        }

                        const existing = packageMap.get(id.toLowerCase());

                        if (!existing) {
                            packageMap.set(id.toLowerCase(), {
                                id,
                                version,
                                latestVersion: pkg.latestVersion,
                                isVulnerable: type === "vulnerable",
                                isOutdated: type === "outdated",
                                isDeprecated: type === "deprecated",
                                severity,
                                advisoryUrl,
                                projects: [projectName],
                                isTransitive: pkg.isTransitive,
                            });
                        } else {
                            if (!existing.projects.includes(projectName)) {
                                existing.projects.push(projectName);
                            }
                            if (pkg.latestVersion && !existing.latestVersion) {
                                existing.latestVersion = pkg.latestVersion;
                            }
                            if (severity && (!existing.severity ||
                                ["Critical", "High", "Moderate", "Low"].indexOf(severity) <
                                ["Critical", "High", "Moderate", "Low"].indexOf(existing.severity || "Low"))) {
                                existing.severity = severity;
                                existing.advisoryUrl = advisoryUrl;
                            }
                        }
                    }
                }
            }

            return Array.from(packageMap.values());
        } catch (error) {
            console.error("JSON parse hatası:", error);
            return [];
        }
    }
}