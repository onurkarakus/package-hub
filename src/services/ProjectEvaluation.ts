import * as fs from "fs/promises";
import * as path from "path";
import { maskXmlComments, PackageRefLocation, readPackageRefs } from "../utils/nugetAudit";

export interface EvaluatedPackage {
    id: string;
    version?: string;
    versionOverride?: string;
    /** The file the item comes from. */
    definingFile?: string;
}

export interface ProjectEvaluation {
    projectPath: string;
    source: "msbuild" | "files";
    cpmEnabled: boolean;
    /** The Directory.Packages.props MSBuild imported, or the nearest one. */
    propsPath?: string;
    assetsFile: string;
    packageReferences: EvaluatedPackage[];
    packageVersions: EvaluatedPackage[];
    globalPackageReferences: EvaluatedPackage[];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readItems(items: unknown): EvaluatedPackage[] {
    if (!Array.isArray(items)) {
        return [];
    }
    const result: EvaluatedPackage[] = [];
    for (const item of items) {
        const id = stringValue(item?.Identity);
        if (!id) {
            continue;
        }
        result.push({
            id,
            version: stringValue(item?.Version),
            versionOverride: stringValue(item?.VersionOverride),
            definingFile: stringValue(item?.DefiningProjectFullPath),
        });
    }
    return result;
}

/**
 * Reads the JSON from `dotnet msbuild -getItem:... -getProperty:...`.
 */
export function parseMsbuildEvaluation(projectPath: string, json: string): ProjectEvaluation {
    const data = JSON.parse(json);
    const properties = data?.Properties ?? {};
    const items = data?.Items ?? {};
    const cpm = String(properties.ManagePackageVersionsCentrally ?? "").toLowerCase() === "true";
    const imported = String(properties.CentralPackageVersionsFileImported ?? "").toLowerCase() === "true";
    const propsPath = stringValue(properties.DirectoryPackagesPropsPath);
    const assetsFile = stringValue(properties.ProjectAssetsFile)
        ?? path.join(path.dirname(projectPath), "obj", "project.assets.json");

    return {
        projectPath,
        source: "msbuild",
        cpmEnabled: cpm,
        propsPath: propsPath && (imported || cpm) ? propsPath : undefined,
        assetsFile,
        packageReferences: readItems(items.PackageReference),
        packageVersions: readItems(items.PackageVersion),
        globalPackageReferences: readItems(items.GlobalPackageReference),
    };
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Walks up from a folder and returns the first file with this name.
 */
export async function findNearestFile(startDirectory: string, fileName: string): Promise<string | undefined> {
    let current = path.resolve(startDirectory);
    for (; ;) {
        const candidate = path.join(current, fileName);
        if (await exists(candidate)) {
            return candidate;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

/**
 * Reads a property from MSBuild XML text. The last definition wins, as in
 * MSBuild. Conditions are not evaluated.
 */
export function readXmlProperty(xml: string, name: string): string | undefined {
    const masked = maskXmlComments(xml);
    const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}\\s*>`, "gi");
    let value: string | undefined;
    for (const match of masked.matchAll(pattern)) {
        value = match[1].trim();
    }
    return value;
}

function isTrue(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value.trim().toLowerCase() === "true";
}

function expandKnown(value: string, projectDirectory: string, projectName: string): string | undefined {
    const expanded = value
        .replace(/\$\(MSBuildProjectDirectory\)/gi, projectDirectory)
        .replace(/\$\(MSBuildThisFileDirectory\)/gi, projectDirectory + path.sep)
        .replace(/\$\(MSBuildProjectName\)/gi, projectName);
    return /\$\(/.test(expanded) ? undefined : expanded;
}

/**
 * Finds project.assets.json without running MSBuild. It honours
 * MSBuildProjectExtensionsPath, BaseIntermediateOutputPath and
 * UseArtifactsOutput when they are written as plain paths.
 */
export async function assetsFileFromFiles(projectPath: string): Promise<string> {
    const projectDirectory = path.dirname(projectPath);
    const projectName = path.basename(projectPath).replace(/\.(csproj|fsproj)$/i, "");
    const buildProps = await findNearestFile(projectDirectory, "Directory.Build.props");
    const texts: string[] = [];
    if (buildProps) {
        texts.push(await fs.readFile(buildProps, "utf8").catch(() => ""));
    }
    texts.push(await fs.readFile(projectPath, "utf8").catch(() => ""));

    const property = (name: string) => {
        let value: string | undefined;
        for (const text of texts) {
            value = readXmlProperty(text, name) ?? value;
        }
        return value;
    };

    const extensions = property("MSBuildProjectExtensionsPath");
    const intermediate = property("BaseIntermediateOutputPath");
    const artifacts = isTrue(property("UseArtifactsOutput"));
    const configured = extensions ?? intermediate;
    if (configured) {
        const expanded = expandKnown(configured, projectDirectory, projectName);
        if (expanded) {
            return path.resolve(projectDirectory, expanded, "project.assets.json");
        }
    }
    if (artifacts) {
        const artifactsPath = property("ArtifactsPath");
        const root = artifactsPath
            ? expandKnown(artifactsPath, buildProps ? path.dirname(buildProps) : projectDirectory, projectName)
            : path.join(buildProps ? path.dirname(buildProps) : projectDirectory, "artifacts");
        if (root) {
            return path.resolve(projectDirectory, root, "obj", projectName, "project.assets.json");
        }
    }
    return path.join(projectDirectory, "obj", "project.assets.json");
}

function toEvaluated(refs: PackageRefLocation[], file: string): EvaluatedPackage[] {
    return refs.map((ref) => ({
        id: ref.id,
        version: ref.declaredVersion,
        versionOverride: ref.versionOverride,
        definingFile: file,
    }));
}

/**
 * Reads the same data as parseMsbuildEvaluation from the files on disk. Used
 * when `dotnet msbuild -getItem` is not available (SDK before 8).
 */
export async function evaluateFromFiles(projectPath: string): Promise<ProjectEvaluation> {
    const projectDirectory = path.dirname(projectPath);
    const projectText = await fs.readFile(projectPath, "utf8").catch(() => "");
    const propsPath = await findNearestFile(projectDirectory, "Directory.Packages.props");
    const propsText = propsPath ? await fs.readFile(propsPath, "utf8").catch(() => "") : "";
    const buildProps = await findNearestFile(projectDirectory, "Directory.Build.props");
    const buildText = buildProps ? await fs.readFile(buildProps, "utf8").catch(() => "") : "";

    let cpm: boolean | undefined;
    for (const text of [propsText, buildText, projectText]) {
        cpm = isTrue(readXmlProperty(text, "ManagePackageVersionsCentrally")) ?? cpm;
    }

    const projectRefs = readPackageRefs(projectText);
    const propsRefs = propsPath ? readPackageRefs(propsText) : [];
    const buildRefs = buildProps ? readPackageRefs(buildText) : [];

    return {
        projectPath,
        source: "files",
        cpmEnabled: cpm === true,
        propsPath: cpm === true ? propsPath : undefined,
        assetsFile: await assetsFileFromFiles(projectPath),
        packageReferences: [
            ...toEvaluated(buildRefs.filter((ref) => ref.tag === "PackageReference"), buildProps ?? ""),
            ...toEvaluated(projectRefs.filter((ref) => ref.tag === "PackageReference"), projectPath),
        ],
        packageVersions: cpm === true && propsPath
            ? toEvaluated(propsRefs.filter((ref) => ref.tag === "PackageVersion"), propsPath)
            : [],
        globalPackageReferences: [
            ...(propsPath ? toEvaluated(propsRefs.filter((ref) => ref.tag === "GlobalPackageReference"), propsPath) : []),
            ...toEvaluated(buildRefs.filter((ref) => ref.tag === "GlobalPackageReference"), buildProps ?? ""),
            ...toEvaluated(projectRefs.filter((ref) => ref.tag === "GlobalPackageReference"), projectPath),
        ],
    };
}

export type EditPlan =
    | { kind: "dotnet-add"; projectPath: string }
    | { kind: "xml-edit"; filePath: string; tag: "PackageVersion" | "GlobalPackageReference" | "PackageReference"; attribute: "Version" | "VersionOverride" };

/**
 * Decides how to write a new version of a package for one project.
 *
 * - A GlobalPackageReference is edited in the file that declares it.
 * - A PackageReference with VersionOverride gets its VersionOverride edited.
 * - Anything else goes through `dotnet add package`, which writes
 *   PackageVersion in Directory.Packages.props when CPM is on.
 */
export function planVersionEdit(evaluation: ProjectEvaluation | undefined, projectPath: string, packageId: string): EditPlan {
    const id = packageId.toLowerCase();
    if (evaluation) {
        const global = evaluation.globalPackageReferences.find((item) => item.id.toLowerCase() === id);
        if (global?.definingFile) {
            return { kind: "xml-edit", filePath: global.definingFile, tag: "GlobalPackageReference", attribute: "Version" };
        }
        const reference = evaluation.packageReferences.find((item) => item.id.toLowerCase() === id);
        if (evaluation.cpmEnabled && reference?.versionOverride && reference.definingFile) {
            return { kind: "xml-edit", filePath: reference.definingFile, tag: "PackageReference", attribute: "VersionOverride" };
        }
    }
    return { kind: "dotnet-add", projectPath };
}

/**
 * Sets the Version (or VersionOverride) of one package element in MSBuild XML.
 * Returns undefined when the element or the attribute is not there. Only that
 * attribute value changes. Comments are never edited.
 */
export function setPackageVersionInXml(
    xml: string,
    tag: "PackageVersion" | "GlobalPackageReference" | "PackageReference",
    packageId: string,
    attribute: "Version" | "VersionOverride",
    newVersion: string
): string | undefined {
    const masked = maskXmlComments(xml);
    const element = new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/>|>)`, "gi");
    for (const match of masked.matchAll(element)) {
        const attributes = match[1];
        const idMatch = /(?:^|\s)(?:Include|Update)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
        const id = (idMatch?.[1] ?? idMatch?.[2] ?? "").trim();
        if (id.toLowerCase() !== packageId.toLowerCase()) {
            continue;
        }
        const versionPattern = new RegExp(`((?:^|\\s)${attribute}\\s*=\\s*)("([^"]*)"|'([^']*)')`, "i");
        const versionMatch = versionPattern.exec(attributes);
        if (!versionMatch) {
            continue;
        }
        const attributesStart = (match.index ?? 0) + 1 + tag.length;
        const valueStart = attributesStart + versionMatch.index + versionMatch[1].length;
        const quote = versionMatch[2][0];
        const valueEnd = valueStart + versionMatch[2].length;
        return `${xml.slice(0, valueStart)}${quote}${newVersion}${quote}${xml.slice(valueEnd)}`;
    }
    return undefined;
}
