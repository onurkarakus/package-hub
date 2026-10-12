import * as assert from "assert";
import * as path from "path";
import {
    classicSolutionPaths,
    csprojPathsInSolution,
    restoreTargetsForProjects,
    slnxPaths,
} from "../services/SolutionTargets";

const root = path.join("/workspace", "app");
const first = path.join(root, "First.sln");
const second = path.join(root, "Second.sln");
const third = path.join(root, "Third.sln");
const audit = path.join(root, "AuditQuickFix.csproj");
const consumer = path.join(root, "Consumer", "Consumer.csproj");
const loose = path.join(root, "Loose", "Loose.csproj");

suite("Solution targets", () => {
    test("every classic solution stays and slnx is left out", () => {
        const paths = [
            path.join(root, "First.sln"),
            path.join(root, "Skip.slnx"),
            path.join(root, "Second.SLN"),
        ];
        assert.deepStrictEqual(classicSolutionPaths(paths), [
            path.join(root, "First.sln"),
            path.join(root, "Second.SLN"),
        ]);
        assert.deepStrictEqual(slnxPaths(paths), [path.join(root, "Skip.slnx")]);
    });

    test("a solution lists its csproj files and skips a solution folder", () => {
        const text = [
            "Microsoft Visual Studio Solution File, Format Version 12.00",
            'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{11111111-1111-1111-1111-111111111111}"',
            "EndProject",
            'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "AuditQuickFix", "AuditQuickFix.csproj", "{20516598-D3E4-47EB-A7F4-D61B691D575A}"',
            "EndProject",
            'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Consumer", "Consumer\\Consumer.csproj", "{B843A335-A49F-43FC-B75B-9B238273D15D}"',
            "EndProject",
        ].join("\n");

        assert.deepStrictEqual(csprojPathsInSolution(text, path.join(root, "Included.sln")), [
            audit,
            consumer,
        ]);
    });

    test("restore uses the solution that contains the project", () => {
        const targets = restoreTargetsForProjects(
            [
                { solutionPath: first, projects: [audit] },
                { solutionPath: second, projects: [consumer] },
            ],
            [consumer]
        );
        assert.deepStrictEqual(targets, [second]);
    });

    test("a project outside every solution is restored itself", () => {
        const targets = restoreTargetsForProjects(
            [{ solutionPath: first, projects: [audit] }],
            [loose]
        );
        assert.deepStrictEqual(targets, [loose]);
    });

    test("one solution is restored once for two of its projects", () => {
        const targets = restoreTargetsForProjects(
            [
                { solutionPath: first, projects: [audit, consumer] },
                { solutionPath: second, projects: [] },
            ],
            [audit, consumer]
        );
        assert.deepStrictEqual(targets, [first]);
    });

    test("a project listed in two solutions restores both", () => {
        const targets = restoreTargetsForProjects(
            [
                { solutionPath: first, projects: [audit] },
                { solutionPath: second, projects: [audit] },
                { solutionPath: third, projects: [consumer] },
            ],
            [audit]
        );
        assert.deepStrictEqual(targets, [first, second]);
    });
});
