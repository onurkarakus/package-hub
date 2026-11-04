import { PackageInfo } from "../models/PackageInfo";
import { highestPatchFrom } from "../utils/nugetAudit";
import { getHttpCacheRoot, readLocalVersions } from "./NuGetLocalCache";

/**
 * Builds a highest-patch list when `dotnet list package --highest-patch`
 * fails (some SDK 10 builds throw "Sequence contains no matching element").
 * The versions come from the list dotnet cached while it read the latest
 * versions. No network request is made.
 */
export async function highestPatchFromLocal(
    packages: PackageInfo[],
    includePrerelease: boolean,
    cacheRoot = getHttpCacheRoot()
): Promise<PackageInfo[]> {
    if (!cacheRoot) {
        return [];
    }
    const result: PackageInfo[] = [];
    for (const pkg of packages) {
        const current = pkg.resolvedVersion || pkg.version;
        const versions = await readLocalVersions(cacheRoot, pkg.id);
        const patch = highestPatchFrom(current, versions, includePrerelease);
        if (patch) {
            result.push({ ...pkg, latestVersion: patch });
        }
    }
    return result;
}
