import * as fs from "fs/promises";
import { assetsFileFor } from "./AssetsLocator";
import { projectNameFromPath } from "./projectFiles";

export type GraphSeverity = "Critical" | "High" | "Moderate" | "Low";

export interface GraphNode {
    id: string;
    label: string;
    type: "project" | "package";
    severity?: GraphSeverity;
}

export interface GraphEdge {
    from: string;
    to: string;
}

export interface PackageGraph {
    projectName: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    error?: string;
}

const SEVERITY_RANK: Record<GraphSeverity, number> = {
    Low: 1,
    Moderate: 2,
    High: 3,
    Critical: 4,
};

export class GraphBuilder {
    static async fromProject(
        projectPath: string,
        severityById?: ReadonlyMap<string, string>
    ): Promise<PackageGraph> {
        const projectName = projectNameFromPath(projectPath);
        const assetsPath = await assetsFileFor(projectPath);

        let text = "";
        try {
            text = await fs.readFile(assetsPath, "utf8");
        } catch {
            return {
                projectName,
                nodes: [],
                edges: [],
                error: "project.assets.json is missing. No edge was invented.",
            };
        }

        try {
            return buildPackageGraph(JSON.parse(text), { projectName, severityById });
        } catch {
            return {
                projectName,
                nodes: [],
                edges: [],
                error: "project.assets.json could not be read. No edge was invented.",
            };
        }
    }
}

export function buildPackageGraph(
    assets: unknown,
    options?: { projectName?: string; severityById?: ReadonlyMap<string, string> }
): PackageGraph {
    const root = asRecord(assets);
    const project = asRecord(root?.project);
    const restore = asRecord(project?.restore);
    const projectName = stringValue(restore?.projectName) || options?.projectName || "Project";
    const nodes = new Map<string, GraphNode>();
    const edges = new Set<string>();
    const projectId = `project:${projectName}`;

    nodes.set(projectId, { id: projectId, label: projectName, type: "project" });

    const targets = asRecord(root?.targets) || {};
    for (const tfm of Object.keys(targets)) {
        const libraries = asRecord(targets[tfm]) || {};
        for (const key of Object.keys(libraries)) {
            const library = asRecord(libraries[key]) || {};
            const parsed = parseLibraryKey(key);
            if (!parsed) {
                continue;
            }

            const isProject = stringValue(library.type) === "project";
            const fromId = isProject
                ? projectNodeId(parsed.id)
                : packageNodeId(parsed.id, parsed.version);
            if (isProject) {
                ensureProject(nodes, fromId, parsed.id);
            } else {
                ensurePackage(nodes, fromId, parsed.id, parsed.version);
            }

            const dependencies = asRecord(library.dependencies) || {};
            for (const dependencyId of Object.keys(dependencies)) {
                const hint = dependencyVersion(dependencies[dependencyId]);
                const resolved = resolveLibraryKey(libraries, dependencyId, hint);
                const to = parseLibraryKey(resolved) || { id: dependencyId, version: hint || "" };
                const toId = packageNodeId(to.id, to.version);
                ensurePackage(nodes, toId, to.id, to.version);
                edges.add(`${fromId}\n${toId}`);
            }
        }
    }

    const frameworks = asRecord(project?.frameworks) || {};
    for (const tfm of Object.keys(frameworks)) {
        const framework = asRecord(frameworks[tfm]) || {};
        const dependencies = asRecord(framework.dependencies) || {};
        const libraries = asRecord(targets[tfm]) || {};

        for (const dependencyId of Object.keys(dependencies)) {
            const dependency = asRecord(dependencies[dependencyId]) || {};
            if (stringValue(dependency.target) === "Project") {
                const toId = projectNodeId(dependencyId);
                ensureProject(nodes, toId, dependencyId);
                edges.add(`${projectId}\n${toId}`);
                continue;
            }

            const hint = stringValue(dependency.version);
            const resolved = resolveLibraryKey(libraries, dependencyId, hint);
            const parsed = parseLibraryKey(resolved) || {
                id: dependencyId,
                version: cleanVersion(hint || ""),
            };
            const toId = packageNodeId(parsed.id, parsed.version);
            ensurePackage(nodes, toId, parsed.id, parsed.version);
            edges.add(`${projectId}\n${toId}`);
        }
    }

    const restoreFrameworks = asRecord(restore?.frameworks) || {};
    for (const tfm of Object.keys(restoreFrameworks)) {
        const framework = asRecord(restoreFrameworks[tfm]) || {};
        const references = asRecord(framework.projectReferences) || {};
        for (const referencePath of Object.keys(references)) {
            const name = projectNameFromPath(referencePath);
            if (!name || name.toLowerCase() === projectName.toLowerCase()) {
                continue;
            }

            const toId = projectNodeId(name);
            ensureProject(nodes, toId, name);
            edges.add(`${projectId}\n${toId}`);
        }
    }

    applyLogSeverity(nodes, root?.logs);
    applyScanSeverity(nodes, options?.severityById);

    const graph: PackageGraph = {
        projectName,
        nodes: Array.from(nodes.values()),
        edges: Array.from(edges).map((edge) => {
            const [from, to] = edge.split("\n");
            return { from, to };
        }),
    };

    if (graph.edges.length === 0) {
        graph.error = "No edges. Nothing was invented.";
    }

    return graph;
}

export function directReferencer(
    graph: PackageGraph,
    packageId: string
): { known: boolean; inGraph: boolean; broughtBy?: string; broughtByKind?: "package" | "project" } {
    if (graph.nodes.length === 0) {
        return { known: false, inGraph: false };
    }

    const wanted = packageId.toLowerCase();
    const inGraph = graph.nodes.some((node) => packageIdOf(node.id)?.toLowerCase() === wanted);
    if (!inGraph) {
        return { known: true, inGraph: false };
    }

    const project = graph.nodes.find((node) => node.id === `project:${graph.projectName}`);
    if (!project) {
        return { known: true, inGraph: true };
    }

    const adjacent = new Map<string, string[]>();
    for (const edge of graph.edges) {
        const next = adjacent.get(edge.from) || [];
        next.push(edge.to);
        adjacent.set(edge.from, next);
    }

    const parent = new Map<string, string | null>();
    const queue = [project.id];
    parent.set(project.id, null);

    while (queue.length > 0) {
        const current = queue.shift() as string;
        if (packageIdOf(current)?.toLowerCase() === wanted) {
            let hop = current;
            while (parent.get(hop) && parent.get(hop) !== project.id) {
                hop = parent.get(hop) as string;
            }

            if (hop === current) {
                return { known: true, inGraph: true };
            }

            const node = graph.nodes.find((item) => item.id === hop);
            const broughtBy = node
                ? (node.type === "package" ? packageIdOf(node.id) : node.label)
                : undefined;
            const broughtByKind = node?.type === "package" || node?.type === "project"
                ? node.type
                : undefined;
            return { known: true, inGraph: true, broughtBy, broughtByKind };
        }

        for (const next of adjacent.get(current) || []) {
            if (!parent.has(next)) {
                parent.set(next, current);
                queue.push(next);
            }
        }
    }

    return { known: true, inGraph: true };
}

export function formatWhyTree(graph: PackageGraph, packageIds: string[]): string {
    if (graph.error) {
        return graph.error;
    }

    const project = graph.nodes.find((node) => node.type === "project");
    if (!project) {
        return "No edges. Nothing was invented.";
    }

    const wanted = new Set(packageIds.map((id) => id.toLowerCase()));
    const labels = wanted.size === 0
        ? directLabels(graph, project.id)
        : pathLabels(graph, project.id, wanted);

    if (labels.length === 0) {
        return "No edges. Nothing was invented.";
    }

    const root: TreeBranch = { label: project.label, children: new Map() };
    for (const path of labels) {
        let cursor = root;
        for (const label of path) {
            let child = cursor.children.get(label);
            if (!child) {
                child = { label, children: new Map() };
                cursor.children.set(label, child);
            }
            cursor = child;
        }
    }

    return [root.label, ...renderBranches(root.children, "")].join("\n");
}

export function formatNodePath(graphs: PackageGraph[], packageId: string): string {
    const toRoot: string[] = [];
    const dependsOn = new Set<string>();
    const dependents = new Set<string>();

    for (const graph of graphs) {
        if (!graph.error) {
            const path = formatWhyTree(graph, [packageId]);
            if (path !== "No edges. Nothing was invented.") {
                toRoot.push(path);
            }
        }

        const node = graph.nodes.find((item) =>
            packageIdOf(item.id)?.toLowerCase() === packageId.toLowerCase()
        );
        if (!node) {
            continue;
        }

        for (const edge of graph.edges) {
            if (edge.from === node.id) {
                const target = graph.nodes.find((item) => item.id === edge.to);
                if (target) {
                    dependsOn.add(displayLabel(target));
                }
            }
            if (edge.to === node.id) {
                const source = graph.nodes.find((item) => item.id === edge.from);
                if (source) {
                    dependents.add(source.label);
                }
            }
        }
    }

    const depends = dependsOn.size === 0
        ? "No dependencies."
        : Array.from(dependsOn).sort().join("\n");
    const usedBy = dependents.size === 0
        ? "No dependents."
        : Array.from(dependents).sort().join("\n");
    const roots = toRoot.length === 0
        ? "No edges. Nothing was invented."
        : toRoot.join("\n\n");

    return [
        "To root",
        roots,
        "",
        "What does this depend on?",
        depends,
        "",
        "What depends on this?",
        usedBy,
    ].join("\n");
}

interface TreeBranch {
    label: string;
    children: Map<string, TreeBranch>;
}

function renderBranches(children: Map<string, TreeBranch>, prefix: string): string[] {
    const list = Array.from(children.values()).sort((left, right) => left.label.localeCompare(right.label));
    const lines: string[] = [];

    list.forEach((child, index) => {
        const last = index === list.length - 1;
        lines.push(`${prefix}${last ? "└── " : "├── "}${child.label}`);
        lines.push(...renderBranches(child.children, prefix + (last ? "    " : "│   ")));
    });

    return lines;
}

function directLabels(graph: PackageGraph, projectId: string): string[][] {
    return graph.edges
        .filter((edge) => edge.from === projectId)
        .map((edge) => graph.nodes.find((node) => node.id === edge.to))
        .filter((node): node is GraphNode => !!node)
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((node) => [displayLabel(node)]);
}

function pathLabels(graph: PackageGraph, projectId: string, wanted: Set<string>): string[][] {
    const adjacent = new Map<string, string[]>();
    for (const edge of graph.edges) {
        const next = adjacent.get(edge.from) || [];
        next.push(edge.to);
        adjacent.set(edge.from, next);
    }

    const paths: string[][] = [];
    for (const packageId of wanted) {
        const path = shortestPath(graph, projectId, packageId, adjacent);
        if (path) {
            paths.push(path);
        }
    }

    return paths.sort((left, right) => left.join("/").localeCompare(right.join("/")));
}

function shortestPath(
    graph: PackageGraph,
    projectId: string,
    packageId: string,
    adjacent: Map<string, string[]>
): string[] | undefined {
    const parent = new Map<string, string | null>();
    const queue = [projectId];
    parent.set(projectId, null);

    while (queue.length > 0) {
        const current = queue.shift() as string;
        const currentPackage = packageIdOf(current);
        if (currentPackage && currentPackage.toLowerCase() === packageId) {
            const labels: string[] = [];
            let cursor: string | null = current;
            while (cursor && cursor !== projectId) {
                const node = graph.nodes.find((item) => item.id === cursor);
                if (node) {
                    labels.push(displayLabel(node));
                }
                cursor = parent.get(cursor) ?? null;
            }
            return labels.reverse();
        }

        for (const next of adjacent.get(current) || []) {
            if (!parent.has(next)) {
                parent.set(next, current);
                queue.push(next);
            }
        }
    }

    return undefined;
}

function displayLabel(node: GraphNode): string {
    return node.severity ? `${node.label} · ${node.severity}` : node.label;
}

function projectNodeId(name: string): string {
    return `project:${name}`;
}

function ensureProject(nodes: Map<string, GraphNode>, id: string, name: string) {
    if (!nodes.has(id)) {
        nodes.set(id, { id, label: name, type: "project" });
    }
}

function ensurePackage(nodes: Map<string, GraphNode>, id: string, packageId: string, version: string) {
    if (nodes.has(id)) {
        return;
    }

    const label = version ? `${packageId} ${version}` : packageId;
    nodes.set(id, { id, label, type: "package" });
}

function applyLogSeverity(nodes: Map<string, GraphNode>, logs: unknown) {
    if (!Array.isArray(logs)) {
        return;
    }

    for (const entry of logs) {
        const log = asRecord(entry);
        const libraryId = stringValue(log?.libraryId);
        const severity = severityFromCode(stringValue(log?.code));
        if (!libraryId || !severity) {
            continue;
        }

        for (const node of nodes.values()) {
            if (node.type === "package" && packageIdOf(node.id)?.toLowerCase() === libraryId.toLowerCase()) {
                node.severity = stronger(node.severity, severity);
            }
        }
    }
}

function applyScanSeverity(nodes: Map<string, GraphNode>, severityById?: ReadonlyMap<string, string>) {
    if (!severityById) {
        return;
    }

    for (const node of nodes.values()) {
        const packageId = packageIdOf(node.id);
        if (!packageId) {
            continue;
        }

        const severity = normalizeSeverity(severityById.get(packageId.toLowerCase()));
        if (severity) {
            node.severity = severity;
        }
    }
}

function severityFromCode(code: string | undefined): GraphSeverity | undefined {
    switch (code) {
        case "NU1901":
            return "Low";
        case "NU1902":
            return "Moderate";
        case "NU1903":
            return "High";
        case "NU1904":
            return "Critical";
        default:
            return undefined;
    }
}

function normalizeSeverity(value: string | undefined): GraphSeverity | undefined {
    switch ((value || "").toLowerCase()) {
        case "low":
            return "Low";
        case "moderate":
            return "Moderate";
        case "high":
            return "High";
        case "critical":
            return "Critical";
        default:
            return undefined;
    }
}

function stronger(current: GraphSeverity | undefined, next: GraphSeverity): GraphSeverity {
    if (!current || SEVERITY_RANK[next] > SEVERITY_RANK[current]) {
        return next;
    }

    return current;
}

function resolveLibraryKey(
    libraries: Record<string, unknown>,
    packageId: string,
    versionHint: string | undefined
): string {
    const prefix = `${packageId}/`.toLowerCase();
    const keys = Object.keys(libraries).filter((key) => key.toLowerCase().startsWith(prefix));
    const cleaned = cleanVersion(versionHint || "");
    const exact = keys.find((key) => key.toLowerCase() === `${packageId}/${cleaned}`.toLowerCase());
    return exact || keys[0] || `${packageId}/${cleaned}`;
}

function parseLibraryKey(key: string): { id: string; version: string } | undefined {
    const slash = key.lastIndexOf("/");
    if (slash <= 0) {
        return undefined;
    }

    return {
        id: key.slice(0, slash),
        version: key.slice(slash + 1),
    };
}

function packageNodeId(packageId: string, version: string): string {
    return `package:${packageId}/${version}`;
}

function packageIdOf(nodeId: string): string | undefined {
    if (!nodeId.startsWith("package:")) {
        return undefined;
    }

    return parseLibraryKey(nodeId.slice("package:".length))?.id;
}

function dependencyVersion(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    return stringValue(asRecord(value)?.version);
}

function cleanVersion(value: string): string {
    return value.replace(/[[\]()\s]/g, "").split(",")[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}
