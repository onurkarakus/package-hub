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

function originCaption(origin: TransitiveOrigin): string {
    if (origin.absentFromGraph) {
        return "bu uyarı paket grafiğinde kalmış olabilir";
    }
    if (origin.broughtBy) {
        return `transitive via ${origin.broughtBy}`;
    }
    return "transitive";
}

export function transitiveCaption(pkg: { transitiveOrigins?: TransitiveOrigin[] }): string {
    const parts = new Set<string>();
    for (const origin of pkg.transitiveOrigins || []) {
        parts.add(originCaption(origin));
    }

    return [...parts].join(" · ");
}

type ProjectRelationPackage = {
    projects?: string[];
    transitiveProjects?: string[];
    transitiveOrigins?: TransitiveOrigin[];
};

function sameProject(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export function projectRelationCaption(pkg: ProjectRelationPackage, projectName: string): string {
    const origin = (pkg.transitiveOrigins || []).find((item) => sameProject(item.project, projectName));
    if (origin) {
        return originCaption(origin);
    }

    const transitiveNames = pkg.transitiveProjects || [];
    if (transitiveNames.some((name) => sameProject(name, projectName))) {
        return "transitive";
    }

    const listed = (pkg.projects || []).some((name) => sameProject(name, projectName));
    const transitiveElsewhere = (pkg.transitiveOrigins || []).length > 0 || transitiveNames.length > 0;
    if (listed && transitiveElsewhere) {
        return "direct";
    }

    return "";
}

export function directProjectNames(pkg: ProjectRelationPackage | undefined): string[] {
    if (!pkg) {
        return [];
    }

    return (pkg.projects || []).filter((name) => !transitiveProject(pkg, name));
}

function transitiveProject(pkg: ProjectRelationPackage, projectName: string): boolean {
    if ((pkg.transitiveOrigins || []).some((item) => sameProject(item.project, projectName))) {
        return true;
    }

    return (pkg.transitiveProjects || []).some((name) => sameProject(name, projectName));
}

export function formatProjectRelations(pkg: ProjectRelationPackage): string {
    const names = pkg.projects || [];
    if (names.length === 0) {
        return "—";
    }

    return names
        .map((name) => {
            const relation = projectRelationCaption(pkg, name);
            return relation ? `${name} · ${relation}` : name;
        })
        .join(", ");
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
