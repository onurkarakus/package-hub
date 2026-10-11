import { PackageInfo, TransitiveOrigin } from "../models/PackageInfo";
import { GraphBuilder, directReferencer } from "./GraphBuilder";

export async function attachTransitiveOrigins(
    packages: PackageInfo[],
    projects: { name: string; path: string }[]
): Promise<void> {
    const pathByName = new Map(projects.map((project) => [project.name.toLowerCase(), project.path]));
    const graphs = new Map<string, Awaited<ReturnType<typeof GraphBuilder.fromProject>>>();

    for (const pkg of packages) {
        const names = pkg.transitiveProjects || [];
        if (names.length === 0) {
            continue;
        }

        const origins: TransitiveOrigin[] = [];
        for (const project of names) {
            const projectPath = pathByName.get(project.toLowerCase());
            if (!projectPath) {
                origins.push({ project, absentFromGraph: false });
                continue;
            }

            let graph = graphs.get(projectPath);
            if (!graph) {
                graph = await GraphBuilder.fromProject(projectPath);
                graphs.set(projectPath, graph);
            }

            const found = directReferencer(graph, pkg.id);
            origins.push({
                project,
                broughtBy: found.broughtBy,
                broughtByKind: found.broughtByKind,
                absentFromGraph: found.known && !found.inGraph,
            });
        }

        pkg.transitiveOrigins = origins;
    }
}

export function transitiveCaption(pkg: { transitiveOrigins?: TransitiveOrigin[] }): string {
    const parts = new Set<string>();
    for (const origin of pkg.transitiveOrigins || []) {
        if (origin.absentFromGraph) {
            parts.add("bu uyarı paket grafiğinde kalmış olabilir");
        } else if (origin.broughtBy) {
            parts.add(`transitive via ${origin.broughtBy}`);
        } else {
            parts.add("transitive");
        }
    }

    return [...parts].join(" · ");
}

export function originForProject(
    pkg: { transitiveOrigins?: TransitiveOrigin[] } | undefined,
    projectName: string | undefined
): TransitiveOrigin | undefined {
    if (!pkg || !projectName) {
        return undefined;
    }

    return pkg.transitiveOrigins?.find((origin) =>
        origin.project.toLowerCase() === projectName.toLowerCase()
    );
}
