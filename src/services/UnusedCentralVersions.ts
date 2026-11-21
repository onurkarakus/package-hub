import * as path from "path";
import { maskXmlComments, readPackageRefs } from "../utils/nugetAudit";
import { ProjectEvaluation } from "./ProjectEvaluation";

/**
 * Finds PackageVersion entries in Directory.Packages.props that no project
 * references, and removes them from the XML.
 */

export interface UnusedCentralVersion {
    filePath: string;
    id: string;
    version?: string;
    line: number;
}

/**
 * A PackageVersion is unused when no evaluated project has a PackageReference
 * or GlobalPackageReference with that id. Every evaluation counts, whatever
 * props file it imports, so a package used anywhere in the workspace stays.
 * Only `Include` entries are listed; `Update` entries change an item defined
 * elsewhere and are left alone.
 */
export function findUnusedCentralVersions(
    propsFiles: { filePath: string; text: string }[],
    evaluations: ProjectEvaluation[]
): UnusedCentralVersion[] {
    const used = new Set<string>();
    for (const evaluation of evaluations) {
        for (const item of [...evaluation.packageReferences, ...evaluation.globalPackageReferences]) {
            used.add(item.id.toLowerCase());
        }
    }
    const result: UnusedCentralVersion[] = [];
    for (const file of propsFiles) {
        for (const ref of readPackageRefs(file.text)) {
            if (ref.tag !== "PackageVersion" || ref.attribute !== "Include") {
                continue;
            }
            if (used.has(ref.id.toLowerCase())) {
                continue;
            }
            result.push({ filePath: path.resolve(file.filePath), id: ref.id, version: ref.declaredVersion, line: ref.line });
        }
    }
    return result.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line);
}

const ELEMENT = /<PackageVersion\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>[\s\S]*?<\/PackageVersion\s*>)/gi;

/**
 * Removes the PackageVersion Include elements with the given ids. When an
 * element is alone on its lines, the whole lines go, so no blank line is left.
 * Comments are never edited.
 */
export function removePackageVersionsFromXml(xml: string, ids: string[]): string {
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    const masked = maskXmlComments(xml);
    const spans: [number, number][] = [];
    for (const match of masked.matchAll(ELEMENT)) {
        const include = /(?:^|\s)Include\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]);
        const id = (include?.[1] ?? include?.[2] ?? "").trim().toLowerCase();
        if (!id || !wanted.has(id)) {
            continue;
        }
        let start = match.index ?? 0;
        let end = start + match[0].length;
        const lineStart = xml.lastIndexOf("\n", start - 1) + 1;
        const newline = xml.indexOf("\n", end);
        const lineEnd = newline < 0 ? xml.length : newline + 1;
        if (xml.slice(lineStart, start).trim() === "" && xml.slice(end, lineEnd).trim() === "") {
            start = lineStart;
            end = lineEnd;
        }
        spans.push([start, end]);
    }
    let result = xml;
    for (const [start, end] of spans.reverse()) {
        result = result.slice(0, start) + result.slice(end);
    }
    return result;
}
