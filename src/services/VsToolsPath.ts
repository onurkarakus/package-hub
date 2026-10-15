import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const webTargets = path.join("WebApplications", "Microsoft.WebApplication.targets");

let environmentPromise: Promise<Record<string, string> | undefined> | undefined;

export function vsToolsPathFromTargets(targetsFile: string): string {
    return path.dirname(path.dirname(targetsFile));
}

export function findTargetsUnder(root: string): string | undefined {
    const visualStudio = path.join(root, "MSBuild", "Microsoft", "VisualStudio");
    if (!fs.existsSync(visualStudio)) {
        return undefined;
    }

    for (const version of fs.readdirSync(visualStudio)) {
        const candidate = path.join(visualStudio, version, webTargets);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

export function visualStudioRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const years = ["18", "2022", "2019"];
    const editions = ["Enterprise", "Professional", "Community", "BuildTools"];
    const roots: string[] = [];

    for (const base of [programFiles, programFilesX86]) {
        for (const year of years) {
            for (const edition of editions) {
                roots.push(path.join(base, "Microsoft Visual Studio", year, edition));
            }
        }
    }

    return roots;
}

export function vsToolsPropsXml(vsToolsPath: string): string {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<Project>",
        "  <PropertyGroup>",
        `    <VSToolsPath>${escapeXml(vsToolsPath)}</VSToolsPath>`,
        "  </PropertyGroup>",
        "</Project>",
        "",
    ].join("\n");
}

export async function vsToolsEnvironment(): Promise<Record<string, string> | undefined> {
    if (process.env.CustomAfterMicrosoftCommonProps) {
        return undefined;
    }

    if (!environmentPromise) {
        environmentPromise = resolveVsToolsEnvironment();
    }

    return environmentPromise;
}

async function resolveVsToolsEnvironment(): Promise<Record<string, string> | undefined> {
    const vsToolsPath = await locateVsToolsPath();
    if (!vsToolsPath) {
        return undefined;
    }

    const propsFile = path.join(os.tmpdir(), "packagehub-vstoolspath.props");
    fs.writeFileSync(propsFile, vsToolsPropsXml(vsToolsPath), "utf8");
    return { CustomAfterMicrosoftCommonProps: propsFile };
}

export async function locateVsToolsPath(): Promise<string | undefined> {
    if (process.platform !== "win32") {
        return undefined;
    }

    const fromVswhere = await installationPathFromVswhere();
    if (fromVswhere) {
        const targets = findTargetsUnder(fromVswhere);
        if (targets) {
            return vsToolsPathFromTargets(targets);
        }
    }

    for (const root of visualStudioRoots()) {
        const targets = findTargetsUnder(root);
        if (targets) {
            return vsToolsPathFromTargets(targets);
        }
    }

    return undefined;
}

async function installationPathFromVswhere(): Promise<string | undefined> {
    const vswhere = path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe"
    );
    if (!fs.existsSync(vswhere)) {
        return undefined;
    }

    try {
        const { stdout } = await execFileAsync(vswhere, [
            "-latest",
            "-products",
            "*",
            "-property",
            "installationPath",
        ], { windowsHide: true, timeout: 15000 });
        return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    } catch {
        return undefined;
    }
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
