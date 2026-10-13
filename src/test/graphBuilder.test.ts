import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildPackageGraph, directReferencer, GraphBuilder } from "../services/GraphBuilder";

suite("GraphBuilder", () => {
    test("a direct package has no parent", () => {
        const graph = buildPackageGraph({
            project: {
                restore: { projectName: "AuditQuickFix" },
                frameworks: {
                    "net8.0": {
                        dependencies: {
                            "Newtonsoft.Json": { target: "Package", version: "[12.0.1, )" },
                        },
                    },
                },
            },
            targets: {
                "net8.0": {
                    "Newtonsoft.Json/12.0.1": { type: "package" },
                },
            },
            logs: [
                { code: "NU1903", libraryId: "Newtonsoft.Json" },
                { code: "NU1905" },
            ],
        });

        assert.strictEqual(graph.projectName, "AuditQuickFix");
        assert.ok(graph.edges.some((edge) =>
            edge.from === "project:AuditQuickFix" && edge.to === "package:Newtonsoft.Json/12.0.1"
        ));
        const node = graph.nodes.find((item) => item.id === "package:Newtonsoft.Json/12.0.1");
        assert.strictEqual(node?.severity, "High");
        assert.strictEqual(graph.nodes.some((item) => item.label === "NU1905"), false);
        assert.deepStrictEqual(directReferencer(graph, "Newtonsoft.Json"), {
            known: true,
            inGraph: true,
        });
    });

    test("a project hop names the owning project", () => {
        const graph = buildPackageGraph({
            project: {
                restore: {
                    projectName: "Consumer",
                    frameworks: {
                        "net8.0": {
                            projectReferences: {
                                "../AuditQuickFix.csproj": {},
                            },
                        },
                    },
                },
                frameworks: {
                    "net8.0": {
                        dependencies: {
                            AuditQuickFix: { target: "Project" },
                        },
                    },
                },
            },
            targets: {
                "net8.0": {
                    "AuditQuickFix/1.0.0": {
                        type: "project",
                        dependencies: { "Newtonsoft.Json": "12.0.1" },
                    },
                    "Newtonsoft.Json/12.0.1": { type: "package" },
                },
            },
        });

        assert.deepStrictEqual(directReferencer(graph, "Newtonsoft.Json"), {
            known: true,
            inGraph: true,
            broughtBy: "AuditQuickFix",
            broughtByKind: "project",
        });
    });

    test("a known graph without the package is absent", () => {
        const graph = buildPackageGraph({
            project: { restore: { projectName: "AuditQuickFix" } },
            targets: {
                "net8.0": {
                    "Other.Pack/1.0.0": { type: "package" },
                },
            },
        });

        assert.deepStrictEqual(directReferencer(graph, "Newtonsoft.Json"), {
            known: true,
            inGraph: false,
        });
    });

    test("no edges says so", () => {
        const graph = buildPackageGraph({
            project: { restore: { projectName: "Empty" } },
        });

        assert.strictEqual(graph.error, "No edges. Nothing was invented.");
    });

    test("a missing assets file is not invented", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "packagehub-graph-"));
        try {
            const graph = await GraphBuilder.fromProject(path.join(root, "AuditQuickFix.csproj"));
            assert.deepStrictEqual(graph.nodes, []);
            assert.deepStrictEqual(graph.edges, []);
            assert.strictEqual(graph.error, "project.assets.json is missing. No edge was invented.");
            assert.deepStrictEqual(directReferencer(graph, "Newtonsoft.Json"), {
                known: false,
                inGraph: false,
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    test("broken assets JSON is not invented", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "packagehub-graph-"));
        try {
            await fs.mkdir(path.join(root, "obj"));
            await fs.writeFile(path.join(root, "obj", "project.assets.json"), "{", "utf8");
            const graph = await GraphBuilder.fromProject(path.join(root, "AuditQuickFix.csproj"));
            assert.deepStrictEqual(graph.nodes, []);
            assert.strictEqual(graph.error, "project.assets.json could not be read. No edge was invented.");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
