import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger";
import { PackageSourceState, ScanState } from "./ScanState";
import { WorkspaceScanner } from "./WorkspaceScanner";

export interface PackageSourceFile {
    cleared: boolean;
    added: string[];
    disabled: string[];
}

function stripComments(xml: string): string {
    return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function sectionBody(xml: string, tag: string): string {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    const parts: string[] = [];
    for (const match of xml.matchAll(pattern)) {
        parts.push(match[1]);
    }
    return parts.join("\n");
}

function attribute(attrs: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
    const value = match?.[1].trim();
    return value ? value : undefined;
}

function addKeys(section: string): string[] {
    const names: string[] = [];
    for (const match of section.matchAll(/<add\b([^>]*)\/?>/gi)) {
        const key = attribute(match[1], "key");
        if (key) {
            names.push(key);
        }
    }
    return names;
}

function disabledKeys(section: string): string[] {
    const names: string[] = [];
    for (const match of section.matchAll(/<add\b([^>]*)\/?>/gi)) {
        const key = attribute(match[1], "key");
        const value = attribute(match[1], "value");
        if (key && value?.toLowerCase() === "true") {
            names.push(key);
        }
    }
    return names;
}

export function parsePackageSourceFile(xml: string): PackageSourceFile {
    const text = stripComments(xml);
    const sources = sectionBody(text, "packageSources");
    const disabled = sectionBody(text, "disabledPackageSources");
    return {
        cleared: /<clear\b[^>]*\/?>/i.test(sources),
        added: addKeys(sources),
        disabled: disabledKeys(disabled),
    };
}

export function mergePackageSourceNames(parts: PackageSourceFile[]): string[] {
    const names: string[] = [];
    const indexOf = (name: string) => names.findIndex((item) => item.toLowerCase() === name.toLowerCase());

    for (const part of parts) {
        if (part.cleared) {
            names.length = 0;
        }
        for (const name of part.added) {
            if (indexOf(name) < 0) {
                names.push(name);
            }
        }
        for (const name of part.disabled) {
            const index = indexOf(name);
            if (index >= 0) {
                names.splice(index, 1);
            }
        }
    }

    return names;
}

export async function refreshNuGetSources(scanner: WorkspaceScanner): Promise<void> {
    const files = await scanner.findNuGetConfigs();
    files.sort((left, right) => {
        const depth = left.fsPath.split(path.sep).length - right.fsPath.split(path.sep).length;
        return depth || left.fsPath.localeCompare(right.fsPath);
    });

    if (files.length === 0) {
        ScanState.setPackageSources({ found: false, unreadable: false, names: [] });
        logger.info("NuGet.config yok.");
        return;
    }

    const parts: PackageSourceFile[] = [];
    for (const file of files) {
        try {
            parts.push(parsePackageSourceFile(await fs.readFile(file.fsPath, "utf8")));
        } catch (error: any) {
            logger.error(`NuGet.config okunamadı (${file.fsPath}): ${error.message}`);
        }
    }

    if (parts.length === 0) {
        ScanState.setPackageSources({ found: true, unreadable: true, names: [] });
        return;
    }

    const names = mergePackageSourceNames(parts);
    ScanState.setPackageSources({ found: true, unreadable: false, names });
    logger.info(names.length > 0 ? `Kaynak: ${names.join(", ")}` : "Kaynak yok.");
}
