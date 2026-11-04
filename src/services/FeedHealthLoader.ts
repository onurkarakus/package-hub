import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { logger } from "../utils/logger";
import { DotnetCli } from "./DotnetCli";
import { parseSourceList, setCredentialProviders, setFeedSources } from "./FeedHealth";
import { refreshNuGetSources } from "./NuGetSources";
import { ScanState } from "./ScanState";
import { WorkspaceScanner } from "./WorkspaceScanner";

async function folderExists(folder: string): Promise<boolean> {
    try {
        return (await fs.stat(folder)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Names the NuGet credential providers installed on this machine. Reads
 * folders and the names of environment variables only, never their values.
 */
export async function installedCredentialProviders(
    env: NodeJS.ProcessEnv = process.env,
    home = os.homedir()
): Promise<string[]> {
    const found: string[] = [];
    const pluginRoot = path.join(env.NUGET_PLUGINS_PATH || path.join(home, ".nuget", "plugins"));
    for (const flavor of ["netcore", "netfx"]) {
        const folder = path.join(pluginRoot, flavor);
        try {
            for (const name of await fs.readdir(folder)) {
                if (/credentialprovider/i.test(name) && await folderExists(path.join(folder, name))) {
                    found.push(name);
                }
            }
        } catch {
            continue;
        }
    }
    if (env.NUGET_PLUGIN_PATHS) {
        found.push("NUGET_PLUGIN_PATHS");
    }
    if (env.NUGET_NETCORE_PLUGIN_PATHS) {
        found.push("NUGET_NETCORE_PLUGIN_PATHS");
    }
    if (env.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS) {
        found.push("VSS_NUGET_EXTERNAL_FEED_ENDPOINTS (Azure Artifacts)");
    }
    return [...new Set(found)];
}

/**
 * Reads the sources dotnet uses for this workspace. `dotnet nuget list source`
 * reads NuGet.config files only. It does not contact the feeds.
 */
export async function refreshFeedSources(cli: DotnetCli, scanner: WorkspaceScanner): Promise<void> {
    const root = scanner.getWorkspaceRoot();
    setCredentialProviders(await installedCredentialProviders());

    if (!root) {
        setFeedSources(undefined, "No workspace is open.");
        return;
    }

    try {
        const sources = parseSourceList(await cli.listSources(root));
        setFeedSources(sources);
        ScanState.setPackageSources({
            found: true,
            unreadable: false,
            names: sources.filter((source) => source.enabled).map((source) => source.name),
        });
        return;
    } catch (error: any) {
        const message = error?.message || String(error);
        logger.info(`dotnet nuget list source failed. Reading NuGet.config files instead: ${message}`);
        setFeedSources(undefined, message);
    }

    await refreshNuGetSources(scanner);
}
