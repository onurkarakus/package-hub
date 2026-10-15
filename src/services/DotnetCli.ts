import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { PackageInfo } from "../models/PackageInfo";
import { projectNameFromPath } from "./projectFiles";
import { logger } from "../utils/logger";
import { vsToolsEnvironment } from "./VsToolsPath";
import { pbkdf2 } from "crypto";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

export interface PackageListResult {
    packages: PackageInfo[];
    projects: string[];
}

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
                env: await this.commandEnv(),
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
                const abortError = new Error("Scan cancelled.");
                abortError.name = "AbortError";
                throw abortError;
            }

            if (error.code === "ENOENT") {
                throw new Error("`dotnet` was not found. Is the .NET SDK installed?");
            }

            // Use the JSON even when the exit code is not 0.
            if (!failOnError && error.stdout && String(error.stdout).trim()) {
                return String(error.stdout).trim();
            }

            const detail = error.stderr || error.stdout || error.message || String(error);
            throw new Error(`dotnet command failed: ${detail}`);
        }
    }

    private async commandEnv(): Promise<NodeJS.ProcessEnv | undefined> {
        try {
            const extra = await vsToolsEnvironment();
            if (!extra) {
                return undefined;
            }

            return { ...process.env, ...extra };
        } catch (error: any) {
            logger.info(`Visual Studio web targets were not added: ${error?.message || error}`);
            return undefined;
        }
    }

    /**
   * Lists vulnerable packages.
   * Command: dotnet list package --vulnerable --include-transitive --format json
   */
    async listVulnerable(
        targetPath: string,
        includeTransitive: boolean = true,
        signal?: AbortSignal
    ): Promise<PackageInfo[]> {
        return (await this.listVulnerableReport(targetPath, includeTransitive, signal)).packages;
    }

    async listVulnerableReport(
        targetPath: string,
        includeTransitive: boolean = true,
        signal?: AbortSignal
    ): Promise<PackageListResult> {
        const transitiveFlag = includeTransitive ? "--include-transitive" : "";
        const command = `dotnet list "${targetPath}" package --vulnerable ${transitiveFlag} --format json`;
        const cwd = path.dirname(targetPath);
        const output = await this.run(command, cwd, 60000, signal);

        return this.readPackageList(output, "vulnerable");
    }

    /**
   * Lists outdated packages.
   * Command: dotnet list package --outdated --include-transitive --format json
   */
    async listOutdated(
        targetPath: string,
        includeTransitive: boolean = true,
        channel: "latest" | "patch" | "minor" = "latest",
        signal?: AbortSignal,
        includePrerelease = false
    ): Promise<PackageInfo[]> {
        return (await this.listOutdatedReport(
            targetPath,
            includeTransitive,
            channel,
            signal,
            includePrerelease
        )).packages;
    }

    async listOutdatedReport(
        targetPath: string,
        includeTransitive: boolean = true,
        channel: "latest" | "patch" | "minor" = "latest",
        signal?: AbortSignal,
        includePrerelease = false
    ): Promise<PackageListResult> {
        const flags = [
            "--outdated",
            includeTransitive ? "--include-transitive" : "",
            channel === "patch" ? "--highest-patch" : "",
            channel === "minor" ? "--highest-minor" : "",
            includePrerelease ? "--include-prerelease" : "",
            "--format json",
        ].filter(Boolean).join(" ");

        const cwd = path.dirname(targetPath);
        const verbFirst = `dotnet list "${targetPath}" package ${flags}`;
        const nounFirst = `dotnet package list --project "${targetPath}" ${flags}`;

        try {
            const output = await this.run(verbFirst, cwd, 60000, signal);
            return this.readPackageList(output, "outdated");
        } catch (error: any) {
            const message = error.message || String(error);
            if (message.includes("`dotnet` was not found") || error.name === "AbortError" || signal?.aborted) {
                throw error;
            }

            try {
                const output = await this.run(nounFirst, cwd, 60000, signal);
                return this.readPackageList(output, "outdated");
            } catch {
                throw error;
            }
        }
    }

    /**
     * Returns plain text for why the package is in the project.
     * SDK 10 wants the project first, then the package. Older SDKs try --project.
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
                throw new Error("`dotnet nuget why` needs .NET SDK 8.0.400 or newer. No tree was invented.");
            }

            try {
                return await this.readWhy(withProjectFlag, cwd);
            } catch (second: any) {
                const secondMessage = second.message || String(second);
                if (this.whyCommandMissing(message) || this.whyCommandMissing(secondMessage)) {
                    throw new Error("`dotnet nuget why` needs .NET SDK 8.0.400 or newer. No tree was invented.");
                }

                throw new Error(`${secondMessage}\nNo tree was invented.`);
            }
        }
    }

    private async readWhy(command: string, cwd: string): Promise<string> {
        const output = await this.run(command, cwd);
        if (!output.trim()) {
            throw new Error("dotnet nuget why returned no output.\nNo tree was invented.");
        }

        return output;
    }

    private whyCommandMissing(message: string): boolean {
        return /unrecognized command or argument ['"]why['"]/i.test(message);
    }

    /**
     * Lists deprecated packages.
     */
    async listDeprecated(targetPath: string, signal?: AbortSignal): Promise<PackageInfo[]> {
        return (await this.listDeprecatedReport(targetPath, signal)).packages;
    }

    async listDeprecatedReport(targetPath: string, signal?: AbortSignal): Promise<PackageListResult> {
        const cwd = path.dirname(targetPath);
        const command = `dotnet list "${targetPath}" package --deprecated --format json`;
        const output = await this.run(command, cwd, 60000, signal);

        return this.readPackageList(output, "deprecated");
    }

    /**
     * Lists every direct package, including the ones that need no attention.
     * Command: dotnet list package --format json
     */
    async listInstalled(targetPath: string, signal?: AbortSignal): Promise<PackageListResult> {
        const cwd = path.dirname(targetPath);
        const command = `dotnet list "${targetPath}" package --format json`;
        const output = await this.run(command, cwd, 60000, signal);

        return this.readPackageList(output, "installed");
    }

    /**
   * Runs restore.
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
   * Updates one package.
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
   * Turns dotnet list package --format json into PackageInfo[].
   * Microsoft sometimes changes the JSON shape.
   * This parser matches the 2025-2026 format.
   */
    parsePackageList(
        jsonOutput: string,
        type: "vulnerable" | "outdated" | "deprecated" | "installed"
    ): PackageInfo[] {
        return this.readPackageList(jsonOutput, type).packages;
    }

    parseListedProjects(jsonOutput: string): string[] {
        return this.readPackageList(jsonOutput, "installed").projects;
    }

    private readPackageList(
        jsonOutput: string,
        type: "vulnerable" | "outdated" | "deprecated" | "installed"
    ): PackageListResult {
        if (!jsonOutput) {
            return { packages: [], projects: [] };
        }

        try {
            const data = JSON.parse(jsonOutput);
            const packageMap = new Map<string, PackageInfo>();
            const listedProjects: string[] = [];

            const projects = data.projects || [];

            for (const project of projects) {
                const projectPath = project.path || project.projectPath || "";
                const fileName = String(projectPath).split(/[\\/]/).pop() || "";
                const named = fileName ? projectNameFromPath(fileName) : "";
                const projectName = named || "Unknown";
                if (named && !listedProjects.some((item) => item.toLowerCase() === named.toLowerCase())) {
                    listedProjects.push(named);
                }

                const frameworks = project.frameworks || [];

                for (const framework of frameworks) {
                    const topLevel = framework.topLevelPackages || [];
                    const transitive = framework.transitivePackages || [];

                    const all = [
                        ...topLevel.map((p: any) => ({ ...p, isTransitive: false })),
                        ...transitive.map((p: any) => ({ ...p, isTransitive: true })),
                    ];

                    for (const pkg of all) {
                        const id = pkg.id || pkg.name;
                        const version =
                            pkg.requestedVersion || pkg.resolvedVersion || pkg.version;

                        if (!id || !version || (type === "installed" && pkg.isTransitive)) {
                            continue;
                        }

                        // Read the vulnerability details.
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

            return {
                packages: Array.from(packageMap.values()),
                projects: listedProjects,
            };
        } catch (error: any) {
            logger.error(`JSON parse error: ${error?.message || error}`);
            return { packages: [], projects: [] };
        }
    }
}