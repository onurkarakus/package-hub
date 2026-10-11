import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { pbkdf2 } from "crypto";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

export class DotnetCli {

    private async run(
        command: string,
        cwd: string,
        timeoutMs: number = 60000,
        signal?: AbortSignal,
        failOnError = false
    ): Promise<string> {
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
                signal,
            });

            if (stdout && stdout.trim()) {
                return stdout.trim();
            }

            if (stderr && !stdout) {
                throw new Error(stderr);
            }

            return "";
        } catch (error: any) {
            if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") {
                const abortError = new Error("Tarama iptal edildi.");
                abortError.name = "AbortError";
                throw abortError;
            }

            if (error.code === "ENOENT") {
                throw new Error("`dotnet` komutu bulunamadı. .NET SDK yüklü mü?");
            }

            // Exit code != 0 olsa bile JSON gelmişse kullan
            if (!failOnError && error.stdout && String(error.stdout).trim()) {
                return String(error.stdout).trim();
            }

            const detail = error.stderr || error.stdout || error.message || String(error);
            throw new Error(`Dotnet komutu başarısız : ${detail}`);
        }
    }

    /**
   * Vulnerable paketleri listeler
   * Komut: dotnet list package --vulnerable --include-transitive --format json
   */
    async listVulnerable(
        targetPath: string,
        includeTransitive: boolean = true,
        signal?: AbortSignal
    ): Promise<PackageInfo[]> {
        const transitiveFlag = includeTransitive ? "--include-transitive" : "";
        const command = `dotnet list "${targetPath}" package --vulnerable ${transitiveFlag} --format json`;
        const cwd = require("path").dirname(targetPath);
        const output = await this.run(command, cwd, 60000, signal);

        return this.parsePackageList(output, "vulnerable");
    }

    /**
   * Outdated paketleri listeler
   * Komut: dotnet list package --outdated --include-transitive --format json
   */
    async listOutdated(
        targetPath: string,
        includeTransitive: boolean = true,
        channel: "latest" | "patch" | "minor" = "latest",
        signal?: AbortSignal
    ): Promise<PackageInfo[]> {
        const flags = [
            "--outdated",
            includeTransitive ? "--include-transitive" : "",
            channel === "patch" ? "--highest-patch" : "",
            channel === "minor" ? "--highest-minor" : "",
            "--format json",
        ].filter(Boolean).join(" ");

        const cwd = path.dirname(targetPath);
        const verbFirst = `dotnet list "${targetPath}" package ${flags}`;
        const nounFirst = `dotnet package list --project "${targetPath}" ${flags}`;

        try {
            const output = await this.run(verbFirst, cwd, 60000, signal);
            return this.parsePackageList(output, "outdated");
        } catch (error: any) {
            const message = error.message || String(error);
            if (message.includes("`dotnet` komutu bulunamadı") || error.name === "AbortError" || signal?.aborted) {
                throw error;
            }

            try {
                const output = await this.run(nounFirst, cwd, 60000, signal);
                return this.parsePackageList(output, "outdated");
            } catch {
                throw error;
            }
        }
    }

    /**
     * Paketin projeye neden girdiğini düz metin olarak döner.
     * SDK 10 argüman sırası proje, sonra paket. Eski SDK için --project denenir.
     */
    async why(projectPath: string, packageId: string): Promise<string> {
        const cwd = path.dirname(projectPath);
        const positional = `dotnet nuget why "${projectPath}" "${packageId}"`;
        const withProjectFlag = `dotnet nuget why "${packageId}" --project "${projectPath}"`;

        try {
            return await this.readWhy(positional, cwd);
        } catch (error: any) {
            const message = error.message || String(error);
            if (this.whyCommandMissing(message)) {
                throw new Error("`dotnet nuget why` için .NET SDK 8.0.400 veya daha yenisi gerekir. Ağaç uydurulmadı.");
            }

            try {
                return await this.readWhy(withProjectFlag, cwd);
            } catch (second: any) {
                const secondMessage = second.message || String(second);
                if (this.whyCommandMissing(message) || this.whyCommandMissing(secondMessage)) {
                    throw new Error("`dotnet nuget why` için .NET SDK 8.0.400 veya daha yenisi gerekir. Ağaç uydurulmadı.");
                }

                throw new Error(`${secondMessage}\nAğaç uydurulmadı.`);
            }
        }
    }

    private async readWhy(command: string, cwd: string): Promise<string> {
        const output = await this.run(command, cwd);
        if (!output.trim()) {
            throw new Error("dotnet nuget why çıktı vermedi.\nAğaç uydurulmadı.");
        }

        return output;
    }

    private whyCommandMissing(message: string): boolean {
        return /unrecognized command or argument ['"]why['"]/i.test(message);
    }

    /**
     * Deprecated paketleri listeler
     */
    async listDeprecated(targetPath: string, signal?: AbortSignal): Promise<PackageInfo[]> {
        const cwd = require("path").dirname(targetPath);
        const command = `dotnet list "${targetPath}" package --deprecated --format json`;
        const output = await this.run(command, cwd, 60000, signal);

        return this.parsePackageList(output, "deprecated");
    }

    /**
   * Restore çalıştırır
   */
    async restore(targetPath: string): Promise<void> {
        const fs = require("fs");
        const path = require("path");

        const isFile = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();

        if (isFile) {
            const cwd = path.dirname(targetPath);
            await this.run(`dotnet restore "${targetPath}"`, cwd);
        }
        else {
            await this.run("dotnet restore", targetPath);
        }
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

    async removePackage(projectPath: string, packageId: string): Promise<void> {
        const command = `dotnet remove "${projectPath}" package "${packageId}"`;
        await this.run(
            command,
            path.dirname(projectPath),
            60000,
            undefined,
            true
        );
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

                        if (!id || !version) {
                            continue;
                        }

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
                                transitiveProjects: pkg.isTransitive ? [projectName] : [],
                            });
                        } else {
                            if (!existing.projects.includes(projectName)) {
                                existing.projects.push(projectName);
                            }
                            if (pkg.isTransitive) {
                                if (!existing.transitiveProjects) {
                                    existing.transitiveProjects = [];
                                }
                                if (!existing.transitiveProjects.includes(projectName)) {
                                    existing.transitiveProjects.push(projectName);
                                }
                            } else {
                                existing.isTransitive = false;
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