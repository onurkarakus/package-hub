import * as fs from "fs";
import * as path from "path";
import { PackageInfo } from "../models/PackageInfo";
import { logger } from "../utils/logger";
import { isValidPackageId, isValidPackageVersion } from "../utils/nugetAudit";
import {
    extractJson,
    PackageListKind,
    PackageListResult,
    parsePackageListJson,
    TargetUnreadableError,
} from "./PackageList";
import {
    abortError,
    CommandNotFoundError,
    errorLines,
    ProcessError,
    RunResult,
    runProcess,
} from "./ProcessRunner";
import { evaluateFromFiles, parseMsbuildEvaluation, ProjectEvaluation } from "./ProjectEvaluation";
import { DotnetTimeouts } from "./Settings";
import { vsToolsEnvironment } from "./VsToolsPath";

export type { PackageListResult } from "./PackageList";

/**
 * Variables that make dotnet output stable and quiet: English messages, no
 * banner, no first-run work, no telemetry.
 */
export const DOTNET_ENVIRONMENT: Readonly<Record<string, string>> = {
    DOTNET_CLI_UI_LANGUAGE: "en",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
};

export function dotnetEnvironment(
    base: NodeJS.ProcessEnv,
    extra?: Record<string, string>
): NodeJS.ProcessEnv {
    return { ...base, ...(extra ?? {}), ...DOTNET_ENVIRONMENT };
}

/**
 * dotnet ran and failed. The message names the exit code and the error lines.
 */
export class DotnetCommandError extends Error {
    constructor(
        readonly verb: string,
        readonly exitCode: number | null,
        readonly lines: string[],
        readonly output: string
    ) {
        const code = exitCode === null ? "no exit code" : `exit code ${exitCode}`;
        const detail = lines.length > 0 ? `\n${lines.join("\n")}` : "";
        super(`dotnet ${verb} failed (${code}).${detail}`);
        this.name = "DotnetCommandError";
    }
}

export class InvalidArgumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidArgumentError";
    }
}

export interface CommandOutput {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

type OutputListener = (output: CommandOutput, args: readonly string[]) => void;

const DEFAULT_TIMEOUTS: DotnetTimeouts = {
    listMs: 120000,
    outdatedMs: 300000,
    restoreMs: 600000,
};

export function assertPackageId(packageId: unknown): asserts packageId is string {
    if (!isValidPackageId(packageId)) {
        throw new InvalidArgumentError(`"${String(packageId)}" is not a valid package id. Nothing was run.`);
    }
}

export function assertPackageVersion(version: unknown): asserts version is string {
    if (!isValidPackageVersion(version)) {
        throw new InvalidArgumentError(`"${String(version)}" is not an exact NuGet version. Nothing was run.`);
    }
}

function assertTargetPath(targetPath: string): void {
    if (typeof targetPath !== "string" || !path.isAbsolute(targetPath) || /[\0\r\n]/.test(targetPath)) {
        throw new InvalidArgumentError(`"${String(targetPath)}" is not an absolute project path. Nothing was run.`);
    }
}

export class DotnetCli {
    private listeners: OutputListener[] = [];
    private environment: Promise<NodeJS.ProcessEnv> | undefined;

    constructor(
        private readonly timeouts: () => DotnetTimeouts = () => DEFAULT_TIMEOUTS,
        private readonly command = "dotnet"
    ) { }

    /**
     * Every dotnet output passes through here, so feed failures can be read
     * from it.
     */
    onOutput(listener: OutputListener): { dispose(): void } {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((item) => item !== listener);
            },
        };
    }

    private async commandEnv(): Promise<NodeJS.ProcessEnv> {
        if (!this.environment) {
            this.environment = (async () => {
                try {
                    const extra = await vsToolsEnvironment();
                    return dotnetEnvironment(process.env, extra);
                } catch (error: any) {
                    logger.info(`Visual Studio web targets were not added: ${error?.message || error}`);
                    return dotnetEnvironment(process.env);
                }
            })();
        }
        return this.environment;
    }

    /**
     * Runs dotnet with an argument array. Never uses a shell.
     */
    async exec(
        args: readonly string[],
        cwd: string,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<RunResult> {
        let result: RunResult;
        try {
            result = await runProcess(this.command, args, {
                cwd,
                timeoutMs,
                signal,
                env: await this.commandEnv(),
            });
        } catch (error: any) {
            if (signal?.aborted || error?.name === "AbortError") {
                throw abortError();
            }
            if (error instanceof CommandNotFoundError) {
                throw new Error("`dotnet` was not found. Is the .NET SDK installed?");
            }
            if (error instanceof ProcessError) {
                this.emit({ stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode }, args);
                const lines = errorLines(`${error.stderr}\n${error.stdout}`);
                throw new DotnetCommandError(
                    `${args[0] ?? ""}`,
                    error.exitCode,
                    [error.message, ...lines],
                    `${error.stdout}\n${error.stderr}`
                );
            }
            throw error;
        }
        this.emit(result, args);
        return result;
    }

    private emit(output: CommandOutput, args: readonly string[]): void {
        for (const listener of this.listeners) {
            try {
                listener(output, args);
            } catch {
                // A listener must not break the command.
            }
        }
    }

    /**
     * Runs a command that must succeed. A non-zero exit code throws with the
     * exit code and the error lines.
     */
    private async execOrThrow(
        args: readonly string[],
        cwd: string,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<RunResult> {
        const result = await this.exec(args, cwd, timeoutMs, signal);
        if (result.exitCode !== 0) {
            const text = `${result.stdout}\n${result.stderr}`;
            throw new DotnetCommandError(args.slice(0, 2).join(" "), result.exitCode, errorLines(text), text);
        }
        return result;
    }

    private async listPackages(
        targetPath: string,
        flags: string[],
        type: PackageListKind,
        timeoutMs: number,
        signal?: AbortSignal,
        allowNounFirst = false
    ): Promise<PackageListResult> {
        assertTargetPath(targetPath);
        const cwd = path.dirname(targetPath);
        const verbFirst = ["list", targetPath, "package", ...flags, "--format", "json"];
        const result = await this.exec(verbFirst, cwd, timeoutMs, signal);
        try {
            return this.readListResult(result, type, cwd);
        } catch (error) {
            const unknownCommand = /unrecognized command|not a valid command|Could not execute because the specified command/i
                .test(`${result.stdout}\n${result.stderr}`);
            if (!allowNounFirst || !unknownCommand) {
                throw error;
            }
        }

        const nounFirst = ["package", "list", "--project", targetPath, ...flags, "--format", "json"];
        const second = await this.exec(nounFirst, cwd, timeoutMs, signal);
        return this.readListResult(second, type, cwd);
    }

    private readListResult(result: RunResult, type: PackageListKind, cwd: string): PackageListResult {
        const json = extractJson(result.stdout);
        if (json === undefined) {
            const text = `${result.stdout}\n${result.stderr}`;
            const lines = errorLines(text);
            if (result.exitCode !== 0) {
                throw new DotnetCommandError("list package", result.exitCode, lines, text);
            }
            throw new TargetUnreadableError(
                lines.length > 0 ? lines.join("\n") : "dotnet list package returned no JSON."
            );
        }
        return parsePackageListJson(json, type, cwd);
    }

    /**
     * Lists vulnerable packages.
     * dotnet list <target> package --vulnerable [--include-transitive] --format json
     */
    async listVulnerable(
        targetPath: string,
        includeTransitive = true,
        signal?: AbortSignal
    ): Promise<PackageInfo[]> {
        return (await this.listVulnerableReport(targetPath, includeTransitive, signal)).packages;
    }

    async listVulnerableReport(
        targetPath: string,
        includeTransitive = true,
        signal?: AbortSignal
    ): Promise<PackageListResult> {
        const flags = ["--vulnerable", ...(includeTransitive ? ["--include-transitive"] : [])];
        return this.listPackages(targetPath, flags, "vulnerable", this.timeouts().listMs, signal);
    }

    async listOutdated(
        targetPath: string,
        includeTransitive = true,
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
        includeTransitive = true,
        channel: "latest" | "patch" | "minor" = "latest",
        signal?: AbortSignal,
        includePrerelease = false
    ): Promise<PackageListResult> {
        const flags = [
            "--outdated",
            ...(includeTransitive ? ["--include-transitive"] : []),
            ...(channel === "patch" ? ["--highest-patch"] : []),
            ...(channel === "minor" ? ["--highest-minor"] : []),
            ...(includePrerelease ? ["--include-prerelease"] : []),
        ];
        return this.listPackages(targetPath, flags, "outdated", this.timeouts().outdatedMs, signal, true);
    }

    async listDeprecated(targetPath: string, signal?: AbortSignal): Promise<PackageInfo[]> {
        return (await this.listDeprecatedReport(targetPath, signal)).packages;
    }

    async listDeprecatedReport(targetPath: string, signal?: AbortSignal): Promise<PackageListResult> {
        return this.listPackages(targetPath, ["--deprecated"], "deprecated", this.timeouts().outdatedMs, signal);
    }

    /**
     * Lists every direct package, including the ones that need no attention.
     */
    async listInstalled(targetPath: string, signal?: AbortSignal): Promise<PackageListResult> {
        return this.listPackages(targetPath, [], "installed", this.timeouts().listMs, signal);
    }

    /**
     * Returns plain text for why the package is in the project.
     * SDK 10 wants the project first, then the package. Older SDKs try --project.
     */
    async why(projectPath: string, packageId: string): Promise<string> {
        assertTargetPath(projectPath);
        assertPackageId(packageId);
        const cwd = path.dirname(projectPath);
        const positional = ["nuget", "why", projectPath, packageId];
        const withProjectFlag = ["nuget", "why", packageId, "--project", projectPath];

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
                if (this.whyCommandMissing(secondMessage)) {
                    throw new Error("`dotnet nuget why` needs .NET SDK 8.0.400 or newer. No tree was invented.");
                }

                throw new Error(`${secondMessage}\nNo tree was invented.`);
            }
        }
    }

    private async readWhy(args: string[], cwd: string): Promise<string> {
        const result = await this.exec(args, cwd, this.timeouts().listMs);
        const text = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0) {
            const lines = errorLines(text);
            throw new DotnetCommandError("nuget why", result.exitCode, lines.length > 0 ? lines : [text.trim()], text);
        }
        if (!result.stdout.trim()) {
            throw new Error("dotnet nuget why returned no output.\nNo tree was invented.");
        }
        return result.stdout.trim();
    }

    private whyCommandMissing(message: string): boolean {
        return /unrecognized command or argument ['"]why['"]/i.test(message);
    }

    /**
     * Runs restore. A failure throws with the exit code and the error lines.
     */
    async restore(targetPath: string, signal?: AbortSignal): Promise<RunResult> {
        assertTargetPath(targetPath);
        const isFile = fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
        if (isFile) {
            return this.execOrThrow(["restore", targetPath], path.dirname(targetPath), this.timeouts().restoreMs, signal);
        }
        return this.execOrThrow(["restore"], targetPath, this.timeouts().restoreMs, signal);
    }

    /**
     * Updates one package with dotnet add package. A failure throws.
     */
    async updatePackage(projectPath: string, packageId: string, version?: string): Promise<void> {
        assertTargetPath(projectPath);
        assertPackageId(packageId);
        const args = ["add", projectPath, "package", packageId];
        if (version !== undefined) {
            assertPackageVersion(version);
            args.push("--version", version);
        }
        await this.execOrThrow(args, path.dirname(projectPath), this.timeouts().restoreMs);
    }

    async removePackage(projectPath: string, packageId: string): Promise<void> {
        assertTargetPath(projectPath);
        assertPackageId(packageId);
        await this.execOrThrow(
            ["remove", projectPath, "package", packageId],
            path.dirname(projectPath),
            this.timeouts().listMs
        );
    }

    /**
     * Reads the evaluated package items and CPM properties of a project.
     * Uses `dotnet msbuild -getItem` (SDK 8 and newer). Falls back to reading
     * the files when that fails.
     */
    async evaluateProject(projectPath: string, signal?: AbortSignal): Promise<ProjectEvaluation> {
        assertTargetPath(projectPath);
        const args = [
            "msbuild",
            projectPath,
            "-nologo",
            "-getItem:PackageReference",
            "-getItem:PackageVersion",
            "-getItem:GlobalPackageReference",
            "-getProperty:ManagePackageVersionsCentrally",
            "-getProperty:CentralPackageVersionsFileImported",
            "-getProperty:DirectoryPackagesPropsPath",
            "-getProperty:ProjectAssetsFile",
        ];
        try {
            const result = await this.exec(args, path.dirname(projectPath), this.timeouts().listMs, signal);
            const json = extractJson(result.stdout);
            if (result.exitCode === 0 && json) {
                return parseMsbuildEvaluation(projectPath, json);
            }
            logger.info(`MSBuild evaluation was not available for ${path.basename(projectPath)}. Reading the files.`);
        } catch (error: any) {
            if (error?.name === "AbortError" || String(error?.message).includes("`dotnet` was not found")) {
                throw error;
            }
            logger.info(`MSBuild evaluation failed for ${path.basename(projectPath)}: ${error?.message || error}`);
        }
        return evaluateFromFiles(projectPath);
    }

    /**
     * Lists the package sources dotnet uses from this folder.
     */
    async listSources(cwd: string): Promise<string> {
        const result = await this.execOrThrow(
            ["nuget", "list", "source", "--format", "detailed"],
            cwd,
            this.timeouts().listMs
        );
        return result.stdout;
    }

    /**
     * Returns a NuGet local folder, for example http-cache or global-packages.
     * This reads configuration only. It makes no network request.
     */
    async localsPath(kind: "http-cache" | "global-packages", cwd: string): Promise<string | undefined> {
        const result = await this.execOrThrow(["nuget", "locals", kind, "--list"], cwd, this.timeouts().listMs);
        const match = new RegExp(`${kind}:\\s*(.+)$`, "mi").exec(result.stdout);
        return match?.[1].trim() || undefined;
    }

    /**
     * Kept for tests and callers that only need the package list.
     */
    parsePackageList(jsonOutput: string, type: PackageListKind): PackageInfo[] {
        return parsePackageListJson(jsonOutput, type).packages;
    }

    parseListedProjects(jsonOutput: string): string[] {
        return parsePackageListJson(jsonOutput, "installed").projects;
    }
}
