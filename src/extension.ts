import * as path from "path";
import * as vscode from "vscode";
import { DotnetCli } from "./services/DotnetCli";
import { WorkspaceScanner } from "./services/WorkspaceScanner";
import { logger } from "./utils/logger";
import { CacheService } from "./services/CacheService";
import { PackageHubTreeProvider } from "./tree/PackageHubTreeProvider";
import { PackageHoverProvider } from "./providers/PackageHoverProvider";
import { ScanState } from "./services/ScanState";
import { loadAdvisoryCatalog } from "./services/AdvisoryCatalog";
import { loadReleaseAges } from "./services/ReleaseAge";
import { attachTransitiveOrigins, directProjectNames } from "./services/TransitiveOrigin";
import { refreshCentralPackages } from "./services/CentralPackages";
import { refreshNuGetSources } from "./services/NuGetSources";
import { workspaceHasAuditDataGap } from "./services/AuditSourceNotice";
import { restoreLastScan, saveLastScan } from "./services/LastScanStore";
import { buildHealthReport } from "./services/HealthReport";
import { buildVulnerabilityReport } from "./services/VulnerabilityReport";
import { chooseQuickFixVersions, isSafeChannelTarget, readPackageRef } from "./utils/nugetAudit";
import { isProjectLoadFailure, projectLoadSummary } from "./services/ProjectLoadFailure";
import { isMsBuildProject, projectNameFromPath } from "./services/projectFiles";
import { provenProjectNames } from "./services/provenProjects";
import {
	classicSolutionPaths,
	readSolutionProjects,
	restoreTargetsForProjects,
	slnxPaths,
} from "./services/SolutionTargets";
import { isPackageProjectFile, ScanGate } from "./services/ScanGate";
import { PackageAuditDiagnostics } from "./providers/PackageAuditDiagnostics";
import { PackageCodeActionProvider } from "./providers/PackageCodeActionProvider";
import { PackageCodeLensProvider } from "./providers/PackageCodeLensProvider";
import { PackageLineDecorations } from "./providers/PackageLineDecorations";
import { HealthDashboardPanel } from "./webview/HealthDashboardPanel";
import { DependencyGraphPanel } from "./webview/DependencyGraphPanel";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

const PROJECT_SCAN_CONCURRENCY = 2;
const scanGate = new ScanGate();

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function advisorySuppressUrl(packageId: string): string | undefined {
	const url = ScanState.findPackage(packageId).vulnerable?.advisoryUrl;
	if (!url || !url.startsWith("https://")) {
		return undefined;
	}
	return url;
}

function alreadySuppressed(text: string, url: string): boolean {
	const id = url.split("/").filter(Boolean).pop()?.toLowerCase();
	for (const match of text.matchAll(/<NuGetAuditSuppress\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi)) {
		const value = match[1].toLowerCase();
		if (value === url.toLowerCase() || (id && value === id)) {
			return true;
		}
	}
	return false;
}

function fileReferencesPackage(text: string, packageId: string): boolean {
	return text.split(/\r?\n/).some((line) => {
		const ref = readPackageRef(line);
		return ref?.kind === "reference" && ref.id.toLowerCase() === packageId.toLowerCase();
	});
}

async function suppressTarget(packageId: string): Promise<vscode.Uri | undefined> {
	const found = ScanState.findPackage(packageId);
	const names = new Set(
		[
			...(found.vulnerable?.projects || []),
			...(found.outdated?.projects || []),
			...(found.deprecated?.projects || []),
		].map((name) => name.toLowerCase())
	);
	const projects = await workspaceScanner.findProjects();
	const named = projects.filter((project) =>
		names.has(workspaceScanner.getProjectName(project).toLowerCase())
	);
	const withReference: vscode.Uri[] = [];
	for (const project of named) {
		const document = await vscode.workspace.openTextDocument(project);
		if (fileReferencesPackage(document.getText(), packageId)) {
			withReference.push(project);
		}
	}
	const candidates = withReference.length > 0 ? withReference : named;
	if (candidates.length === 0) {
		return undefined;
	}

	const editor = vscode.window.activeTextEditor;
	const active = editor
		? candidates.find((project) => project.fsPath === editor.document.uri.fsPath)
		: undefined;
	if (active) {
		return active;
	}
	if (candidates.length === 1) {
		return candidates[0];
	}

	const picked = await vscode.window.showQuickPick(
		candidates.map((project) => ({
			label: workspaceScanner.getProjectName(project),
			uri: project,
		})),
		{ placeHolder: "Which project should the suppress entry be written to?" }
	);
	return picked?.uri;
}

async function openSuppressDiff(packageId: string, url: string): Promise<void> {
	const uri = await suppressTarget(packageId);
	if (!uri) {
		vscode.window.showWarningMessage("No csproj was found for this package. The suppress entry was not written.");
		return;
	}

	const document = await vscode.workspace.openTextDocument(uri);
	const text = document.getText();
	if (alreadySuppressed(text, url)) {
		vscode.window.showInformationMessage("This advisory is already in NuGetAuditSuppress.");
		return;
	}

	const closing = text.lastIndexOf("</Project>");
	if (closing < 0) {
		vscode.window.showErrorMessage("The csproj has no closing tag. The suppress entry was not written.");
		return;
	}

	const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
	const snippet = [
		"",
		"  <ItemGroup>",
		`    <NuGetAuditSuppress Include="${escapeXml(url)}" />`,
		"  </ItemGroup>",
		"",
	].join(eol);
	const edit = new vscode.WorkspaceEdit();
	edit.insert(uri, document.positionAt(closing), snippet);
	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage("The suppress draft could not be opened. The file was not changed.");
		return;
	}

	const at = document.positionAt(closing);
	await vscode.window.showTextDocument(document, {
		selection: new vscode.Range(at, at.translate(0, 4)),
		preview: false,
	});
	try {
		await vscode.commands.executeCommand("workbench.files.action.compareWithSaved");
	} catch (error: any) {
		logger.info(`The diff command did not open: ${error?.message || error}`);
	}
	vscode.window.showInformationMessage(
		"The suppress draft opened in a diff. Save it, then run Restore All. If you do not save, the file stays unchanged."
	);
}

interface TargetScan {
	vulnerable: any[];
	outdated: any[];
	deprecated: any[];
	patch: any[];
	installed: any[];
	provenProjects: string[];
	loadError?: string;
}

async function scanOneTarget(
	cli: DotnetCli,
	targetPath: string,
	label: string,
	signal: AbortSignal
): Promise<TargetScan> {
	const settled = await Promise.allSettled([
		cli.listVulnerableReport(targetPath, true, signal),
		cli.listOutdatedReport(targetPath, false, "latest", signal, ScanState.includePrerelease()),
		cli.listDeprecatedReport(targetPath, signal),
		cli.listOutdatedReport(targetPath, false, "patch", signal, ScanState.includePrerelease()),
		cli.listInstalled(targetPath, signal),
	]);

	if (settled.some((result) =>
		result.status === "rejected"
		&& String(result.reason?.message || result.reason).includes("`dotnet` was not found")
	)) {
		throw new Error("`dotnet` was not found. Is the .NET SDK installed?");
	}

	const names = ["vulnerable", "outdated", "deprecated", "patch", "installed"] as const;
	const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length === names.length) {
		const message = String(failures[0].reason?.message || failures[0].reason);
		if (isProjectLoadFailure(message)) {
			return {
				vulnerable: [],
				outdated: [],
				deprecated: [],
				patch: [],
				installed: [],
				provenProjects: [],
				loadError: message,
			};
		}
	}

	const reports = names.map((name, index) => {
		const result = settled[index];
		if (result.status === "fulfilled") {
			return result.value;
		}

		if (!signal.aborted) {
			logger.error(`[${label}] could not read ${name}: ${result.reason?.message || result.reason}`);
		}
		return { packages: [] as any[], projects: [] as string[] };
	});

	const proofReady = [0, 1, 2, 4].every((index) => settled[index].status === "fulfilled");
	const provenProjects = proofReady
		? provenProjectNames([
			reports[4].projects,
			reports[0].projects,
			reports[1].projects,
			reports[2].projects,
		])
		: [];

	return {
		vulnerable: reports[0].packages,
		outdated: reports[1].packages,
		deprecated: reports[2].packages,
		patch: reports[3].packages,
		installed: reports[4].packages,
		provenProjects,
	};
}

function attachHighestPatch(groups: any[][], patch: any[]): void {
	const byId = new Map<string, string>();
	for (const pkg of patch) {
		if (pkg?.id && pkg.latestVersion) {
			byId.set(String(pkg.id).toLowerCase(), String(pkg.latestVersion));
		}
	}

	for (const group of groups) {
		for (const pkg of group) {
			const candidate = byId.get(String(pkg.id).toLowerCase());
			pkg.highestPatch = chooseQuickFixVersions(pkg.version, candidate, undefined).patch;
		}
	}
}

async function restoreForProjects(projectPaths: string[]): Promise<void> {
	const found = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
	const solutions = classicSolutionPaths(found);
	if (projectPaths.length === 0) {
		for (const solutionPath of solutions) {
			await dotnetCli.restore(solutionPath);
		}
		return;
	}

	const membership = await readSolutionProjects(solutions);
	for (const solution of membership) {
		if (solution.error) {
			logger.error(`Could not read the solution (${solution.solutionPath}): ${solution.error}`);
		}
	}

	for (const target of restoreTargetsForProjects(membership, projectPaths)) {
		await dotnetCli.restore(target);
	}
}

async function runPool(
	count: number,
	limit: number,
	token: vscode.CancellationToken,
	worker: (index: number) => Promise<void>
): Promise<void> {
	let cursor = 0;
	const lanes = Math.min(limit, count);

	await Promise.all(Array.from({ length: lanes }, async () => {
		while (cursor < count) {
			if (token.isCancellationRequested) {
				return;
			}

			const index = cursor++;
			await worker(index);
		}
	}));
}

async function applySafeUpdate(channel: "patch" | "minor"): Promise<void> {
	const projects = await workspaceScanner.findProjects();
	if (projects.length === 0) {
		vscode.window.showErrorMessage("No .csproj or .fsproj file was found in the workspace.");
		return;
	}

	const label = channel === "patch" ? "Highest patch" : "Highest minor";
	const targets: {
		packageId: string;
		from: string;
		to: string;
		projectPath: string;
		projectName: string;
	}[] = [];
	let blocked = false;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "PackageHub",
			cancellable: false,
		},
		async (progress) => {
			for (const project of projects) {
				if (blocked) {
					return;
				}

				const projectName = workspaceScanner.getProjectName(project);
				progress.report({ message: `Reading ${label}: ${projectName}` });

				try {
					const listed = await dotnetCli.listOutdated(
						project.fsPath,
						false,
						channel,
						undefined,
						ScanState.includePrerelease()
					);
					for (const pkg of listed) {
						if (!pkg.latestVersion || !isSafeChannelTarget(pkg.version, pkg.latestVersion, channel)) {
							continue;
						}

						targets.push({
							packageId: pkg.id,
							from: pkg.version,
							to: pkg.latestVersion,
							projectPath: project.fsPath,
							projectName,
						});
					}
				} catch (error: any) {
					const message = error.message || String(error);
					logger.show(true);
					logger.error(`Could not read the ${label} list (${project.fsPath}): ${message}`);
					if (message.includes("`dotnet` was not found")) {
						blocked = true;
						vscode.window.showErrorMessage(message);
					}
				}
			}
		}
	);

	if (blocked) {
		return;
	}

	if (targets.length === 0) {
		vscode.window.showInformationMessage(`No packages to update for ${label}. Major versions are not written.`);
		return;
	}

	const preview = targets
		.slice(0, 15)
		.map((target) => `${target.packageId} ${target.from} → ${target.to} (${target.projectName})`);
	const extra = targets.length > 15 ? `\n… and ${targets.length - 15} more` : "";
	const confirm = await vscode.window.showWarningMessage(
		`${label}\n\n${preview.join("\n")}${extra}\n\nMajor versions are not written.`,
		{ modal: true },
		"Yes, Update"
	);

	if (confirm !== "Yes, Update") {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "PackageHub",
			cancellable: false,
		},
		async (progress) => {
			try {
				for (const target of targets) {
					progress.report({
						message: `${target.packageId} → ${target.to} (${target.projectName})`,
					});
					await dotnetCli.updatePackage(target.projectPath, target.packageId, target.to);
				}
				logger.info(`${label}: updated ${targets.length} packages.`);

				progress.report({ message: "Restore is running..." });
				const updatedProjects = [...new Set(targets.map((target) => target.projectPath))];
				await restoreForProjects(updatedProjects);

				vscode.window.showInformationMessage(`${label}: updated ${targets.length} targets.`);
				await vscode.commands.executeCommand("packageHub.scanWorkspace");
			} catch (error: any) {
				const message = error.message || String(error);
				logger.show(true);
				logger.error(`${label} failed: ${message}`);
				vscode.window.showErrorMessage(`Update failed: ${message}`);
			}
		}
	);
}

function paintScanStatus(item: vscode.StatusBarItem): void {
	const status = ScanState.statusBarLabel();
	item.text = status.text;
	item.backgroundColor = status.healthy
		? undefined
		: new vscode.ThemeColor("statusBarItem.warningBackground");
}

export function activate(context: vscode.ExtensionContext) {
	// Servisler
	dotnetCli = new DotnetCli();
	workspaceScanner = new WorkspaceScanner();
	const cacheService = new CacheService();

	// Status Bar
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	statusBarItem.tooltip = "PackageHub – Click to open the Health Dashboard";
	statusBarItem.show();
	statusBarItem.command = "packageHub.showHealthDashboard";
	context.subscriptions.push(statusBarItem);

	// Tree View
	const treeProvider = new PackageHubTreeProvider();
	const treeView = vscode.window.createTreeView("packageHubExplorer", {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});
	treeProvider.attach(treeView);
	context.subscriptions.push(treeView);

	if (restoreLastScan(context.workspaceState)) {
		paintScanStatus(statusBarItem);
		treeProvider.refresh();
		HealthDashboardPanel.refreshIfOpen();
	} else {
		statusBarItem.text = "$(package) PackageHub";
	}

	const auditDiagnostics = new PackageAuditDiagnostics(workspaceScanner);
	const codeActionProvider = new PackageCodeActionProvider(dotnetCli, workspaceScanner);
	const codeLensProvider = new PackageCodeLensProvider(codeActionProvider, workspaceScanner);
	const lineDecorations = new PackageLineDecorations(workspaceScanner);
	context.subscriptions.push(
		codeLensProvider,
		lineDecorations,
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file", pattern: "**/*.{csproj,fsproj,props}" },
			codeLensProvider
		)
	);
	if (ScanState.getScannedAt()) {
		void auditDiagnostics.refresh().finally(() => {
			codeLensProvider.refresh();
			lineDecorations.refresh();
		});
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("packageHub.minimumSeverity")) {
			paintScanStatus(statusBarItem);
			treeProvider.refresh();
			HealthDashboardPanel.refreshIfOpen();
			codeLensProvider.refresh();
			lineDecorations.refresh();
			void auditDiagnostics.refresh();
		}

		if (event.affectsConfiguration("packageHub.includePrerelease")) {
			codeActionProvider.clearCache();
		}
	}));

	void refreshCentralPackages(workspaceScanner)
		.then(() => {
			treeProvider.refresh();
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`Could not read CPM: ${error.message}`);
		});

	void refreshNuGetSources(workspaceScanner)
		.then(() => {
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`Could not read NuGet.config: ${error.message}`);
		});

	void workspaceScanner.findProjects()
		.then(async (projects) => {
			void vscode.commands.executeCommand("setContext", "packageHub.hasProjects", projects.length > 0);
			const gap = await workspaceHasAuditDataGap(projects.map((project) => project.fsPath));
			ScanState.setAuditDataGap(gap);
			paintScanStatus(statusBarItem);
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`Could not read the audit source warning: ${error.message}`);
		});

	// Hover is the explanation. Update links read the lightbulb cache and do not start a new dotnet call.
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ language: "xml", scheme: "file", pattern: "**/*.{csproj,fsproj,props}" }
		],
		new PackageHoverProvider(codeActionProvider, workspaceScanner)
	);
	context.subscriptions.push(hoverProvider);
	context.subscriptions.push(
		auditDiagnostics,
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file", pattern: "**/*.{csproj,fsproj,props}" },
			codeActionProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	// A new or deleted project file changes what the Package Health view shows.
	const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj}", false, true, false);
	projectWatcher.onDidCreate(() => treeProvider.refresh());
	projectWatcher.onDidDelete(() => treeProvider.refresh());
	context.subscriptions.push(projectWatcher);

	const openWalkthroughCommand = vscode.commands.registerCommand(
		"packageHub.openWalkthrough",
		() => vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`${context.extension.id}#packageHub.getStarted`,
			false
		)
	);
	context.subscriptions.push(openWalkthroughCommand);

	// Health Dashboard
	const showDashboardCommand = vscode.commands.registerCommand(
		"packageHub.showHealthDashboard",
		() => {
			HealthDashboardPanel.createOrShow();
		}
	);

	// ======================
	// Komutlar
	// ======================

	function mergeById(packages: any[]): any[] {
		const map = new Map<string, any>();

		for (const p of packages) {
			const key = p.id.toLowerCase();
			const existing = map.get(key);

			if (!existing) {

				const versionByProject: Record<string, string> = {};

				for (const proj of p.projects || []) {
					versionByProject[proj] = p.version;
				}

				map.set(key, {
					...p,
					projects: [...(p.projects || [])],
					versionByProject,
					transitiveProjects: [...(p.transitiveProjects || [])],
				});
				continue;
			}

			for (const proj of p.projects || []) {
				if (!existing.projects.includes(proj)) {
					existing.projects.push(proj);
				}

				if (!existing.versionByProject) {
					existing.versionByProject = {};
				}
				existing.versionByProject[proj] = p.version;
			}

			if (p.latestVersion && !existing.latestVersion) {
				existing.latestVersion = p.latestVersion;
			}

			if (!existing.transitiveProjects) {
				existing.transitiveProjects = [];
			}
			for (const project of p.transitiveProjects || []) {
				if (!existing.transitiveProjects.includes(project)) {
					existing.transitiveProjects.push(project);
				}
			}
			if (!p.isTransitive) {
				existing.isTransitive = false;
			}
		}

		return Array.from(map.values());
	}

	function packageOnActiveLine(): {
		id: string;
		version?: string;
		kind: "reference" | "version";
		projectName?: string;
		document: vscode.TextDocument;
	} | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}

		const ref = readPackageRef(editor.document.lineAt(editor.selection.active.line).text);
		if (!ref) {
			return undefined;
		}

		const projectName = isMsBuildProject(editor.document.fileName)
			? workspaceScanner.getProjectName(editor.document.uri)
			: undefined;
		return { ...ref, projectName, document: editor.document };
	}

	function lineCurrentVersion(ref: {
		id: string;
		version?: string;
		kind: "reference" | "version";
	}): string | undefined {
		const found = ScanState.findPackage(ref.id);
		const usesCentral = ref.kind === "version" || !ref.version;
		const centralVersion = ref.kind === "version"
			? ref.version
			: ScanState.getCentralVersion(ref.id);
		return usesCentral
			? centralVersion
			: (ref.version || found.vulnerable?.version || found.outdated?.version);
	}

	async function updateActiveLine(channel: "patch" | "latest"): Promise<void> {
		const ref = packageOnActiveLine();
		if (!ref) {
			vscode.window.showWarningMessage("No package was found on this line.");
			return;
		}

		const peek = await codeActionProvider.peekUpdateTargets(
			ref.document,
			ref.id,
			lineCurrentVersion(ref)
		);
		if (!peek.ready) {
			vscode.window.showInformationMessage(
				"The patch list is not ready yet. The update was not started."
			);
			return;
		}

		const version = channel === "patch" ? peek.patch : peek.latest;
		if (!version) {
			vscode.window.showWarningMessage(
				`No ${channel} version for ${ref.id}. The update was not started.`
			);
			return;
		}

		await vscode.commands.executeCommand("packageHub.updateVulnerable", {
			packageId: ref.id,
			version,
			projectName: ref.projectName,
		});
	}

	const ignorePackageCommand = vscode.commands.registerCommand(
		"packageHub.ignorePackage",
		async (packageId?: string | { packageId?: string }) => {

			if (packageId && typeof packageId === "object") {
				packageId = packageId.packageId;
			}

			if (typeof packageId !== "string" || packageId.trim().length === 0) {
				const editor = vscode.window.activeTextEditor;
				const inProjectFile = !!editor && /\.(csproj|props)$/i.test(editor.document.fileName);
				const fromLine = packageOnActiveLine()?.id;
				if (fromLine) {
					packageId = fromLine;
				} else if (inProjectFile) {
					vscode.window.showWarningMessage("No package was found on this line.");
					return;
				}
			}

			if (!packageId) {
				const all = [
					...ScanState.getVulnerable(),
					...ScanState.getOutDated(),
					...ScanState.getDeprecated(),
				];

				const uniqueIds = [...new Set(all.map((p) => p.id))];
				if (uniqueIds.length === 0) {
					vscode.window.showWarningMessage(
						"No package to ignore. Run Scan Workspace first."
					);
					return;
				}

				const picked = await vscode.window.showQuickPick(uniqueIds, {
					placeHolder: "Select the package to ignore",
				});

				if (!picked) {
					return;
				}

				packageId = picked;
			}

			const url = advisorySuppressUrl(packageId);
			const choice = await vscode.window.showQuickPick(
				[
					{
						label: "Hide in PackageHub",
						description: "List",
						detail: "The build warning stays",
					},
					{
						label: "Suppress this advisory",
						description: url ? "NuGetAuditSuppress" : "Off",
						detail: url || "No advisory URL",
					},
				],
				{ placeHolder: `Ignore for ${packageId}` }
			);
			if (!choice) {
				return;
			}
			if (choice.label === "Suppress this advisory") {
				if (!url) {
					vscode.window.showWarningMessage("No advisory URL. Suppress is unavailable.");
					return;
				}
				await openSuppressDiff(packageId, url);
				return;
			}

			const config = vscode.workspace.getConfiguration("packageHub");
			const current = config.get<string[]>("ignoredPackages", []);

			if (current.some((id) => id.toLowerCase() === packageId.toLowerCase())) {
				vscode.window.showInformationMessage(`${packageId} zaten ignore listesinde.`);
				return;
			}

			await config.update("ignoredPackages", [...current, packageId], vscode.ConfigurationTarget.Workspace);

			vscode.window.showInformationMessage(
				`${packageId} is hidden from PackageHub lists. The build warning stays.`
			);
			await vscode.commands.executeCommand("packageHub.scanWorkspace");
		}
	);

	const unignorePackageCommand = vscode.commands.registerCommand(
		"packageHub.unignorePackage",
		async () => {
			const config = vscode.workspace.getConfiguration("packageHub");
			const current = config.get<string[]>("ignoredPackages") || [];

			if (current.length === 0) {
				vscode.window.showInformationMessage("The ignore list is empty.");
				return;
			}

			const picked = await vscode.window.showQuickPick(current, {
				placeHolder: "Select the package to unignore",
			});

			if (!picked) {
				return;
			}

			await config.update(
				"ignoredPackages",
				current.filter((id) => id.toLowerCase() !== picked.toLowerCase()),
				vscode.ConfigurationTarget.Workspace
			);

			vscode.window.showInformationMessage(`${picked} was removed from the ignore list.`);
			await vscode.commands.executeCommand("packageHub.scanWorkspace");
		}
	);

	const explainCommand = vscode.commands.registerCommand(
		"packageHub.explainSelectedPackage",
		async () => {
			try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage("No editor is open.");
				return;
			}

			const line = editor.document.lineAt(editor.selection.active.line).text;
			const match = line.match(/PackageReference\s+Include="([^"]+)"/i);

			if (!match) {
				vscode.window.showWarningMessage(
					"No PackageReference was found on this line."
				);
				return;
			}

			const packageId = match[1];
			const { vulnerable, outdated, deprecated } = ScanState.findPackage(packageId);
			const info = vulnerable || outdated || deprecated;

			if (!info) {
				vscode.window.showInformationMessage(
					`${packageId} looks healthy (or no scan has run yet).`
				);
				return;
			}

			const lines = [
				`${packageId}`,
				info.version ? `Mevcut: ${info.version}` : undefined,
				info.latestVersion ? `Suggested: ${info.latestVersion}` : undefined,
				info.severity ? `Severity: ${info.severity}` : undefined,
				vulnerable ? "Durum: Vulnerable" : undefined,
				!vulnerable && deprecated ? "Durum: Deprecated" : undefined,
				!vulnerable && !deprecated && outdated ? "Durum: Outdated" : undefined,
				info.projects?.length ? `Projects: ${info.projects.join(", ")}` : undefined,
			].filter(Boolean);

			const buttons: string[] = [];
			if (info.advisoryUrl) {
				buttons.push("Open Advisory");
			}
			if (info.latestVersion) {
				buttons.push("Update");
			}

			const action = await vscode.window.showInformationMessage(
				lines.join(" | "),
				...buttons
			);

			if (action === "Open Advisory" && info.advisoryUrl) {
				await vscode.env.openExternal(vscode.Uri.parse(info.advisoryUrl));
			}

			if (action === "Update") {
				await vscode.commands.executeCommand("packageHub.updateVulnerable", {
					packageId: info.id,
					version: info.latestVersion,
				});
			}
			} catch (error: any) {
				logger.error(`Could not explain the package: ${error?.message || error}`);
				vscode.window.showErrorMessage("Could not explain the package.");
			}
		}
	);

	const performWorkspaceScan = async () => {
			const workspaceRoot = workspaceScanner.getWorkspaceRoot();

			if (!workspaceRoot) {
				vscode.window.showErrorMessage(
					"No workspace is open. Open a folder."
				);
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: true,
				},
				async (progress, token) => {
					progress.report({ message: "Scanning packages..." });

					const abort = new AbortController();
					const cancelSub = token.onCancellationRequested(() => abort.abort());

					try {
						logger.info(`Scan started: ${workspaceRoot}`);

						// Clear the cache on every scan.
						cacheService.invalidateAll();

						let vulnerable: any[] = [];
						let outdated: any[] = [];
						let deprecated: any[] = [];
						let patch: any[] = [];
						const skipped: string[] = [];
						const provenNames: string[] = [];
						const buckets = {
							vulnerable: [] as any[],
							outdated: [] as any[],
							deprecated: [] as any[],
							patch: [] as any[],
							installed: [] as any[],
						};

						const remember = (lists: TargetScan) => {
							buckets.vulnerable.push(...lists.vulnerable);
							buckets.outdated.push(...lists.outdated);
							buckets.deprecated.push(...lists.deprecated);
							buckets.patch.push(...lists.patch);
							buckets.installed.push(...lists.installed);
							for (const name of lists.provenProjects) {
								if (!provenNames.some((item) => item.toLowerCase() === name.toLowerCase())) {
									provenNames.push(name);
								}
							}
						};

						const scanProjectPaths = async (projectPaths: string[]) => {
							await runPool(projectPaths.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
								const projectPath = projectPaths[index];
								const label = projectNameFromPath(projectPath);
								progress.report({ message: `${index + 1}/${projectPaths.length} ${label}` });
								try {
									const lists = await scanOneTarget(
										dotnetCli,
										projectPath,
										label,
										abort.signal
									);
									if (lists.loadError) {
										skipped.push(projectPath);
										logger.info(`Skipped ${projectPath}. ${projectLoadSummary(lists.loadError)}`);
										return;
									}

									remember(lists);
								} catch (projectError: any) {
									logger.error(`Could not scan the project (${projectPath}): ${projectError.message}`);
									if (String(projectError.message).includes("`dotnet` was not found")) {
										abort.abort();
										throw projectError;
									}
								}
							});
						};

						const foundSolutions = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
						for (const slnx of slnxPaths(foundSolutions)) {
							logger.info(`.slnx skipped: ${slnx}`);
						}
						const solutions = classicSolutionPaths(foundSolutions);

						if (token.isCancellationRequested) {
							logger.info("Scan cancelled. Results were not drawn.");
							return;
						}

						if (solutions.length > 0) {
							await runPool(solutions.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
								const targetPath = solutions[index];
								const label = path.basename(targetPath);
								progress.report({ message: `${index + 1}/${solutions.length} ${label}` });

								try {
									const lists = await scanOneTarget(
										dotnetCli,
										targetPath,
										label,
										abort.signal
									);
									if (!lists.loadError) {
										remember(lists);
										return;
									}

									logger.info(`The solution could not be loaded in one pass. Scanning its projects: ${targetPath}`);
									const projects = (await readSolutionProjects([targetPath]))[0]?.projects ?? [];
									if (projects.length === 0) {
										logger.error(`Could not scan the solution (${targetPath}): ${projectLoadSummary(lists.loadError)}`);
										return;
									}

									await scanProjectPaths(projects);
								} catch (solutionError: any) {
									logger.error(`Could not scan the solution (${targetPath}): ${solutionError.message}`);
									if (String(solutionError.message).includes("`dotnet` was not found")) {
										abort.abort();
										throw solutionError;
									}
								}
							});
						} else {
							// 2. When there is no solution, scan every project.
							const projects = await workspaceScanner.findProjects();

							if (projects.length === 0) {
								vscode.window.showErrorMessage(
									"No .sln, .csproj, or .fsproj file was found in the workspace."
								);
								return;
							}

							await scanProjectPaths(projects.map((project) => project.fsPath));
						}

						vulnerable = mergeById(buckets.vulnerable);
						outdated = mergeById(buckets.outdated);
						deprecated = mergeById(buckets.deprecated);
						patch = mergeById(buckets.patch);

						if (skipped.length > 0) {
							const names = skipped.slice(0, 3).map((item) => projectNameFromPath(item));
							const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
							vscode.window.showWarningMessage(
								`PackageHub skipped ${skipped.length} project${skipped.length === 1 ? "" : "s"} that dotnet could not load: ${names.join(", ")}${extra}. The other projects were scanned.`
							);
						}

						if (token.isCancellationRequested) {
							logger.info("Scan cancelled. Results were not drawn.");
							return;
						}

						const ignored = (
							vscode.workspace
								.getConfiguration("packageHub")
								.get<string[]>("ignoredPackages") || []
						).map((id) => id.toLowerCase());

						attachHighestPatch([vulnerable, outdated], patch);
						vulnerable = vulnerable.filter((p) => !ignored.includes(p.id.toLowerCase()));
						outdated = outdated.filter((p) => !ignored.includes(p.id.toLowerCase()));
						deprecated = deprecated.filter((p) => !ignored.includes(p.id.toLowerCase()));
						const installed = mergeById(buckets.installed)
							.filter((pkg) => !ignored.includes(pkg.id.toLowerCase()));

						try {
							const projectFiles = await workspaceScanner.findProjects();
							await attachTransitiveOrigins(
								vulnerable,
								projectFiles.map((project) => ({
									name: workspaceScanner.getProjectName(project),
									path: project.fsPath,
								}))
							);
						} catch (originError: any) {
							logger.error(`Could not read the transitive parent: ${originError.message}`);
						}

						ScanState.setResults(
							vulnerable,
							outdated,
							deprecated,
							undefined,
							installed,
							provenNames
						);

						try {
							await loadAdvisoryCatalog();
						} catch (advisoryError: any) {
							logger.error(`Could not read the advisory record: ${advisoryError.message}`);
						}

						try {
							await loadReleaseAges();
						} catch (ageError: any) {
							logger.error(`Could not read the release-age record: ${ageError.message}`);
						}

						treeProvider.refresh();

						try {
							await refreshCentralPackages(workspaceScanner);
						} catch (cpmError: any) {
							logger.error(`Could not read CPM: ${cpmError.message}`);
						}

						try {
							await refreshNuGetSources(workspaceScanner);
						} catch (sourceError: any) {
							logger.error(`Could not read NuGet.config: ${sourceError.message}`);
						}

						try {
							const noticed = await workspaceScanner.findProjects();
							const gap = await workspaceHasAuditDataGap(noticed.map((project) => project.fsPath));
							ScanState.setAuditDataGap(gap);
						} catch (auditNoticeError: any) {
							logger.error(`Could not read the audit source warning: ${auditNoticeError.message}`);
						}

						paintScanStatus(statusBarItem);

						try {
							await saveLastScan(context.workspaceState);
						} catch (saveError: any) {
							logger.error(`Could not save the last scan: ${saveError.message}`);
						}

						const message = `Scan finished → Vulnerable: ${vulnerable.length}, Outdated: ${outdated.length}, Deprecated: ${deprecated.length}`;
						vscode.window.showInformationMessage(message);
						logger.info(message);

						// Update Dashboard If Open
						HealthDashboardPanel.refreshIfOpen();

						codeActionProvider.clearCache();
						codeLensProvider.refresh();
						lineDecorations.refresh();
						try {
							await auditDiagnostics.refresh();
							void codeActionProvider.prefetch(auditDiagnostics.affectedProjects())
								.finally(() => {
									codeLensProvider.refresh();
									lineDecorations.refresh();
								});
						} catch (diagError: any) {
							logger.error(`Quick Fix diagnostic error: ${diagError.message}`);
						}

						DependencyGraphPanel.refreshIfOpen();
					} catch (error: any) {
						if (token.isCancellationRequested) {
							logger.info("Scan cancelled. Results were not drawn.");
							return;
						}

						const errorMessage = error.message || String(error);
						logger.error(`Scan error: ${errorMessage}`);
						vscode.window.showErrorMessage(
							`PackageHub scan error: ${errorMessage}`
						);
					} finally {
						cancelSub.dispose();
					}
				}
			);
	};

	const scanCommand = vscode.commands.registerCommand(
		"packageHub.scanWorkspace",
		async () => {
			if (!scanGate.begin()) {
				logger.info("A scan is already running. It will run once more when it finishes.");
				return;
			}
			try {
				do {
					await performWorkspaceScan();
				} while (scanGate.end());
			} catch (error) {
				scanGate.forceIdle();
				throw error;
			}
		}
	);

	const updateCommand = vscode.commands.registerCommand(
		"packageHub.updateVulnerable",
		async (args?: { packageId: string; version: string; projectName?: string }) => {
			if (!args || !args.packageId) {
				vscode.window.showWarningMessage("The package update details are missing.");
				return;
			}

			const packageId = args.packageId;
			const version = args.version;

			const { outdated, vulnerable, deprecated } = ScanState.findPackage(packageId);
			const relatedProjectNames =
				outdated?.projects ||
				vulnerable?.projects ||
				deprecated?.projects ||
				[];

			const allProjects = await workspaceScanner.findProjects();

			const targetProjects = allProjects.filter((p) => {
				const name = workspaceScanner.getProjectName(p);
				return relatedProjectNames.includes(name);
			});

			if (targetProjects.length === 0) {
				vscode.window.showErrorMessage(
					`Could not match a project for ${packageId}. It was not added to every project.`
				);
				logger.error(`Update cancelled: no matching project → ${packageId}`);
				return;
			}

			let projectsToUpdate = targetProjects;

			if (args.projectName) {
				projectsToUpdate = targetProjects.filter(
					(p) => workspaceScanner.getProjectName(p) === args.projectName
				);
			}

			const projectNames = projectsToUpdate
				.map((p) => workspaceScanner.getProjectName(p))
				.join(", ");

			if (!version) {
				const cont = await vscode.window.showWarningMessage(
					`No newer version was suggested for ${packageId}.\n\nA newer version may not exist under the same package id (for example xunit → xunit.v3).\nRun "dotnet add package ${packageId}" anyway?`,
					{ modal: true },
					"Try anyway",
					"Cancel"
				);

				if (cont !== "Try anyway") {
					return;
				}
			}

			const currentVersion = vulnerable?.version || outdated?.version;
			const heading = currentVersion
				? `${packageId} ${currentVersion} → ${version}`
				: `${packageId} → ${version}`;
			const confirm = await vscode.window.showWarningMessage(
				`${heading}\n\nProjects to update:\n${projectNames}`,
				{ modal: true },
				"Yes, Update"
			);

			if (confirm !== "Yes, Update") {
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: false,
				},
				async (progress) => {
					try {
						for (const project of projectsToUpdate) {
							progress.report({
								message: `${packageId} updating → ${workspaceScanner.getProjectName(project)}`,
							});

							await dotnetCli.updatePackage(project.fsPath, packageId, version);
						}
						logger.info(`Updated ${packageId} → ${version} in ${projectsToUpdate.length} projects.`);

						// Restore
						progress.report({ message: "Restore is running..." });

						try {
							await restoreForProjects(projectsToUpdate.map((project) => project.fsPath));
							logger.info("Restore finished.");
						} catch (restoreError: any) {
							logger.error(`Restore error: ${restoreError.message}`);
							vscode.window.showWarningMessage(
								`The package was updated, but restore failed: ${restoreError.message}`
							);
						}

						vscode.window.showInformationMessage(
							`${packageId} → ${version} updated in ${projectsToUpdate.length} projects.`
						);

						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.error(`Update error: ${msg}`);
						vscode.window.showErrorMessage(`Update failed: ${msg}`);
					}
				}
			);
		}
	);

	const updateHighestPatchCommand = vscode.commands.registerCommand(
		"packageHub.updateHighestPatch",
		() => applySafeUpdate("patch")
	);

	const updateHighestMinorCommand = vscode.commands.registerCommand(
		"packageHub.updateHighestMinor",
		() => applySafeUpdate("minor")
	);

	const removePackageCommand = vscode.commands.registerCommand(
		"packageHub.removePackage",
		async (args?: { packageId?: string; projectName?: string }) => {
			const requestedId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
			const requestedProject = typeof args?.projectName === "string" ? args.projectName.trim() : "";
			const fromItem = requestedId.length > 0;
			let packageId = requestedId;
			const editor = vscode.window.activeTextEditor;
			const editorIsProject = !!editor && isMsBuildProject(editor.document.fileName);
			if (!packageId && editor) {
				packageId = readPackageRef(
					editor.document.lineAt(editor.selection.active.line).text
				)?.id || "";
			}

			if (!packageId) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}

			const allProjects = await workspaceScanner.findProjects();
			let targets = allProjects;
			if (requestedProject) {
				const named = allProjects.find(
					(project) => workspaceScanner.getProjectName(project) === requestedProject
				);
				targets = named ? [named] : [];
			} else if (!fromItem && editorIsProject && editor) {
				const active = allProjects.find((project) => project.fsPath === editor.document.uri.fsPath);
				targets = active ? [active] : [editor.document.uri];
			} else {
				const found = ScanState.findPackage(packageId);
				const names = new Set(
					[
						...(found.vulnerable?.projects || []),
						...(found.outdated?.projects || []),
						...(found.deprecated?.projects || []),
					].map((name) => name.toLowerCase())
				);
				const matched = allProjects.filter((project) =>
					names.has(workspaceScanner.getProjectName(project).toLowerCase())
				);
				targets = matched;
			}

			if (targets.length === 0) {
				vscode.window.showErrorMessage(
					`Could not match a project for ${packageId}. Removal was not started.`
				);
				return;
			}

			const projectNames = targets
				.map((project) => workspaceScanner.getProjectName(project))
				.join("\n");
			const confirm = await vscode.window.showWarningMessage(
				`Remove ${packageId}?\n\n${projectNames}`,
				{ modal: true },
				"Yes, Remove"
			);
			if (confirm !== "Yes, Remove") {
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: false,
				},
				async (progress) => {
					let removed = 0;
					try {
						for (const project of targets) {
							progress.report({
								message: `${packageId} removing → ${workspaceScanner.getProjectName(project)}`,
							});
							await dotnetCli.removePackage(project.fsPath, packageId);
							removed += 1;
						}
						logger.info(`Removed ${packageId} from ${removed} projects.`);

						vscode.window.showInformationMessage(`${packageId} was removed.`);
						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.show(true);
						logger.error(`Remove error: ${msg}`);
						vscode.window.showErrorMessage(`Remove failed: ${msg}`);
						if (removed > 0) {
							await vscode.commands.executeCommand("packageHub.scanWorkspace");
						}
					}
				}
			);
		}
	);

	const updateLinePatchCommand = vscode.commands.registerCommand(
		"packageHub.updateLinePatch",
		() => updateActiveLine("patch")
	);

	const updateLineLatestCommand = vscode.commands.registerCommand(
		"packageHub.updateLineLatest",
		() => updateActiveLine("latest")
	);

	const openLineAdvisoryCommand = vscode.commands.registerCommand(
		"packageHub.openLineAdvisory",
		async () => {
			const ref = packageOnActiveLine();
			if (!ref) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}

			const url = advisorySuppressUrl(ref.id);
			if (!url) {
				vscode.window.showWarningMessage("No advisory link. The update was not started.");
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const updateSelectedCommand = vscode.commands.registerCommand(
		"packageHub.updateSelectedPackage",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Could not select a package");
				return;
			}

			await vscode.commands.executeCommand("packageHub.updateVulnerable", {
				packageId: item.packageId,
				version: item.latestVersion
			});
		}
	);

	const revealPackageCommand = vscode.commands.registerCommand(
		"packageHub.revealPackage",
		async (args?: { packageId?: string }) => {
			const packageId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
			if (!packageId) {
				vscode.window.showWarningMessage("Could not select a package.");
				return;
			}

			const found = ScanState.findPackage(packageId);
			const info = found.vulnerable || found.outdated || found.deprecated;
			const preferred = directProjectNames(info).map((name) => name.toLowerCase());
			const projects = await workspaceScanner.findProjects();
			const ordered = [...projects].sort((left, right) => {
				const leftName = workspaceScanner.getProjectName(left).toLowerCase();
				const rightName = workspaceScanner.getProjectName(right).toLowerCase();
				const leftRank = preferred.indexOf(leftName);
				const rightRank = preferred.indexOf(rightName);
				const leftOrder = leftRank === -1 ? preferred.length : leftRank;
				const rightOrder = rightRank === -1 ? preferred.length : rightRank;
				return leftOrder - rightOrder || leftName.localeCompare(rightName);
			});

			for (const project of ordered) {
				let document: vscode.TextDocument;
				try {
					document = await vscode.workspace.openTextDocument(project);
				} catch {
					continue;
				}

				const line = packageReferenceLine(document.getText(), packageId);
				if (line < 0) {
					continue;
				}

				const editor = await vscode.window.showTextDocument(document, { preview: true });
				const position = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter
				);
				return;
			}

			await DependencyGraphPanel.show(packageId);
		}
	);

	const showPackageInfoCommand = vscode.commands.registerCommand(
		"packageHub.showPackageInfo",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Could not select a package.");
				return;
			}

			const { vulnerable, outdated, deprecated } = ScanState.findPackage(item.packageId);
			const info = vulnerable || outdated || deprecated;
			const version = info?.version || (typeof item.version === "string" ? item.version : undefined);

			const lines = [
				`Package: ${item.packageId}`,
				version ? `Mevcut: ${version}` : undefined,
				info?.latestVersion ? `Latest version: ${info.latestVersion}` : undefined,
				info?.severity ? `Severity: ${info.severity}` : undefined,
				info?.projects?.length ? `Projects: ${info.projects.join(", ")}` : undefined,
			].filter(Boolean);

			vscode.window.showInformationMessage(lines.join(" | "));
		}
	);

	const openNugetCommand = vscode.commands.registerCommand(
		"packageHub.openNugetPage",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Could not select a package.");
				return;
			}

			const url = vscode.Uri.parse(`https://www.nuget.org/packages/${item.packageId}`);
			await vscode.env.openExternal(url);
		}
	);

	const restoreAllCommand = vscode.commands.registerCommand(
		"packageHub.restoreAll",
		async () => {
			const workspaceRoot = workspaceScanner.getWorkspaceRoot();
			if (!workspaceRoot) {
				vscode.window.showErrorMessage("No workspace is open.");
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "Restore is running..." });

					try {
						const projects = await workspaceScanner.findProjects();
						const found = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
						if (classicSolutionPaths(found).length === 0 && projects.length === 0) {
							vscode.window.showErrorMessage(
								"No .sln, .csproj, or .fsproj was found to restore."
							);
							return;
						}

						await restoreForProjects(projects.map((project) => project.fsPath));

						vscode.window.showInformationMessage("Restore finished.");

						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.error(`Restore error: ${msg}`);
						vscode.window.showErrorMessage(`Restore failed: ${msg}`);
					}
				}
			);
		}
	);

	const showGraphCommand = vscode.commands.registerCommand(
		"packageHub.showDependencyGraph",
		async (args?: { packageId?: string }) => {
			let packageId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
			if (!packageId) {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					packageId = readPackageRef(
						editor.document.lineAt(editor.selection.active.line).text
					)?.id || "";
				}
			}

			if (!packageId) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}

			await DependencyGraphPanel.show(packageId);
		}
	);

	const whyPackageCommand = vscode.commands.registerCommand(
		"packageHub.whyPackage",
		async (args?: { packageId?: string; projectName?: string }) => {
			const requestedId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
			const requestedProject = typeof args?.projectName === "string" ? args.projectName.trim() : "";
			const editor = vscode.window.activeTextEditor;

			let packageId = requestedId;
			if (!packageId && editor) {
				packageId = readPackageRef(
					editor.document.lineAt(editor.selection.active.line).text
				)?.id || "";
			}

			if (!packageId) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}

			const projects = await workspaceScanner.findProjects();
			let projectPath: string | undefined;

			if (requestedProject) {
				const match = projects.find(
					(project) => workspaceScanner.getProjectName(project) === requestedProject
				);
				if (!match) {
					vscode.window.showWarningMessage(
						`No project was found for ${packageId}: ${requestedProject}`
					);
					return;
				}
				projectPath = match.fsPath;
			} else if (editor && isMsBuildProject(editor.document.uri.fsPath)) {
				projectPath = editor.document.uri.fsPath;
			} else if (projects.length === 1) {
				projectPath = projects[0].fsPath;
			} else if (projects.length === 0) {
				vscode.window.showErrorMessage("No .csproj or .fsproj file was found in the workspace.");
				return;
			} else {
				const picked = await vscode.window.showQuickPick(
					projects.map((project) => ({
						label: workspaceScanner.getProjectName(project),
						description: project.fsPath,
						fsPath: project.fsPath,
					})),
					{ placeHolder: "Select a project for Why" }
				);
				if (!picked) {
					return;
				}
				projectPath = picked.fsPath;
			}

			if (!projectPath) {
				vscode.window.showErrorMessage("No .csproj or .fsproj file was found in the workspace.");
				return;
			}

			const selectedProject = projectPath;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: `Finding why ${packageId} is here…` });

					try {
						const text = await dotnetCli.why(selectedProject, packageId);
						logger.show(true);
						logger.info(`Why: ${packageId} (${selectedProject})`);
						logger.appendLine(text);
						await DependencyGraphPanel.show(packageId);
						vscode.window.showInformationMessage(
							`Opened the path for ${packageId}. The CLI text is in the Output panel.`
						);
					} catch (error: any) {
						const message = error.message || String(error);
						logger.show(true);
						logger.error(`Why failed: ${message}`);
						vscode.window.showErrorMessage(message);
					}
				}
			);
		}
	);

	const copyHealthReportCommand = vscode.commands.registerCommand(
		"packageHub.copyHealthReport",
		async () => {
			const markdown = buildHealthReport();
			if (!markdown) {
				vscode.window.showInformationMessage("Scan first");
				return;
			}

			try {
				await vscode.env.clipboard.writeText(markdown);
			} catch (error: any) {
				logger.error(`Could not copy the health report: ${error?.message || error}`);
				vscode.window.showErrorMessage("Could not copy the health report.");
				return;
			}
			vscode.window.showInformationMessage("Health report copied to the clipboard.");
		}
	);

	const copyVulnerabilityReportCommand = vscode.commands.registerCommand(
		"packageHub.copyVulnerabilityReport",
		async () => {
			const markdown = buildVulnerabilityReport();
			if (markdown === undefined) {
				vscode.window.showInformationMessage("Scan first");
				return;
			}
			if (markdown === "") {
				vscode.window.showInformationMessage("No vulnerabilities.");
				return;
			}

			try {
				await vscode.env.clipboard.writeText(markdown);
			} catch (error: any) {
				logger.error(`Could not copy the vulnerability report: ${error?.message || error}`);
				vscode.window.showErrorMessage("Could not copy the vulnerability report.");
				return;
			}
			vscode.window.showInformationMessage("Vulnerability report copied to the clipboard.");
		}
	);

	const openAdvisoryCommand = vscode.commands.registerCommand(
		"packageHub.openAdvisory",
		async (url?: string) => {
			if (!url) {
				vscode.window.showWarningMessage("No advisory link. The update was not started.");
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const quickFixBlockedCommand = vscode.commands.registerCommand(
		"packageHub.quickFixBlocked",
		async (message?: string) => {
			vscode.window.showWarningMessage(
				message || "No patch version. The update was not started."
			);
		}
	);

	const codeLensPendingCommand = vscode.commands.registerCommand(
		"packageHub.codeLensPending",
		async () => {
			vscode.window.showInformationMessage(
				"The lens above the line shows the version once the patch list is ready. Latest is not on this line."
			);
		}
	);

	context.subscriptions.push(
		scanCommand,
		updateCommand,
		updateHighestPatchCommand,
		updateHighestMinorCommand,
		showDashboardCommand,
		updateSelectedCommand,
		removePackageCommand,
		updateLinePatchCommand,
		updateLineLatestCommand,
		openLineAdvisoryCommand,
		revealPackageCommand,
		showPackageInfoCommand,
		openNugetCommand,
		restoreAllCommand,
		showGraphCommand,
		whyPackageCommand,
		copyHealthReportCommand,
		copyVulnerabilityReportCommand,
		explainCommand,
		ignorePackageCommand,
		unignorePackageCommand,
		openAdvisoryCommand,
		quickFixBlockedCommand,
		codeLensPendingCommand,
		logger
	);

	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.scheme !== "file") {
			return;
		}
		if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
			return;
		}
		if (!isPackageProjectFile(document.uri.fsPath)) {
			return;
		}
		void vscode.commands.executeCommand("packageHub.scanWorkspace");
	}));

	const scanOnStartup = vscode.workspace
		.getConfiguration("packageHub")
		.get<boolean>("scanOnStartup", true);

	if (
		process.env.PACKAGEHUB_DISABLE_STARTUP_SCAN !== "1"
		&& scanOnStartup
		&& workspaceScanner.getWorkspaceRoot()
	) {
		setTimeout(() => {
			// Opening the view in a folder without projects activates the extension too. Do not scan there.
			void workspaceScanner.findProjects().then((projects) => {
				if (projects.length > 0) {
					void vscode.commands.executeCommand("packageHub.scanWorkspace");
				}
			});
		}, 2000);
	}
}

function packageReferenceLine(text: string, packageId: string): number {
	const lines = text.split(/\r?\n/);
	const id = packageId.toLowerCase();
	for (let index = 0; index < lines.length; index += 1) {
		const ref = readPackageRef(lines[index]);
		if (ref && ref.kind === "reference" && ref.id.toLowerCase() === id) {
			return index;
		}
	}

	return -1;
}

export function deactivate() {
}