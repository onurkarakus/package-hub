import * as path from "path";
import * as vscode from "vscode";
import { PackageEntry, PackageInfo } from "./models/PackageInfo";
import { DotnetCli } from "./services/DotnetCli";
import { WorkspaceScanner } from "./services/WorkspaceScanner";
import { logger } from "./utils/logger";
import { PackageHubTreeProvider } from "./tree/PackageHubTreeProvider";
import { PackageHoverProvider } from "./providers/PackageHoverProvider";
import { ScanState } from "./services/ScanState";
import { advisoryLabel, advisoryVerdict, refreshAdvisoryCatalog } from "./services/AdvisoryCatalog";
import { latestReleasePreferred, loadReleaseAges, releaseAgeNotice } from "./services/ReleaseAge";
import { attachTransitiveOrigins, directProjectNames } from "./services/TransitiveOrigin";
import { refreshCentralPackages } from "./services/CentralPackages";
import { readRestoreLogs } from "./services/AuditSourceNotice";
import { restoreLastScan, saveLastScan } from "./services/LastScanStore";
import { buildHealthReport } from "./services/HealthReport";
import { buildVulnerabilityReport } from "./services/VulnerabilityReport";
import {
	chooseQuickFixVersions,
	isSafeChannelTarget,
	isValidPackageId,
	isValidPackageVersion,
	packageRefAtLine,
	readPackageRefs,
	versionChange,
} from "./utils/nugetAudit";
import { isProjectLoadFailure, projectLoadSummary } from "./services/ProjectLoadFailure";
import { isMsBuildProject, isPackageDocumentPath, projectNameFromPath } from "./services/projectFiles";
import { provenProjectNames } from "./services/provenProjects";
import {
	classicSolutionPaths,
	planScanTargets,
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
import { aggregatePackages, emptyPackageList, PackageListResult, TargetUnreadableError } from "./services/PackageList";
import { killAllProcesses, processSlots } from "./services/ProcessRunner";
import { dotnetTimeouts, maxDotnetProcesses, onlineLookupsEnabled } from "./services/Settings";
import { parseFeedFailures, recordFeedFailures, resetFeedFailures } from "./services/FeedHealth";
import { refreshFeedSources } from "./services/FeedHealthLoader";
import { defaultHttpCachePath, setHttpCacheRoot } from "./services/NuGetLocalCache";
import { forgetAssetsFiles, rememberAssetsFile } from "./services/AssetsLocator";
import { planVersionEdit, ProjectEvaluation, setPackageVersionInXml, EditPlan } from "./services/ProjectEvaluation";
import { Debouncer, WriteQueue } from "./services/WriteQueue";
import { buildUpdateSummary, UpdateSummaryAdvisory, UpdateSummaryProject } from "./services/UpdateSummary";
import { highestPatchFromLocal } from "./services/PatchFallback";
import { projectScope, withoutDowngrades } from "./services/UpdateScope";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

const PROJECT_SCAN_CONCURRENCY = 2;
const scanGate = new ScanGate();
const writeQueue = new WriteQueue();
const evaluations = new Map<string, Promise<ProjectEvaluation>>();
/** Files PackageHub saves itself. Their save does not start another scan. */
const ownSaves = new Set<string>();

function pathKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

function errorText(error: any): string {
	return error?.message || String(error);
}

/**
 * Reads the evaluated MSBuild data for a project once per change. The cache is
 * dropped when a project or props file changes.
 */
function evaluationFor(projectPath: string, signal?: AbortSignal): Promise<ProjectEvaluation> {
	const key = pathKey(projectPath);
	const known = evaluations.get(key);
	if (known) {
		return known;
	}
	const job = dotnetCli.evaluateProject(projectPath, signal).then((evaluation) => {
		rememberAssetsFile(projectPath, evaluation.assetsFile);
		return evaluation;
	});
	evaluations.set(key, job);
	job.catch(() => evaluations.delete(key));
	return job;
}

function forgetEvaluations(): void {
	evaluations.clear();
	forgetAssetsFiles();
}

async function resolveHttpCacheRoot(): Promise<string> {
	const root = workspaceScanner.getWorkspaceRoot() || process.cwd();
	try {
		const found = await dotnetCli.localsPath("http-cache", root);
		if (found) {
			return found;
		}
	} catch (error) {
		logger.info(`dotnet nuget locals failed. Using the default cache folder: ${errorText(error)}`);
	}
	return defaultHttpCachePath();
}

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
	return readPackageRefs(text).some((ref) =>
		ref.kind === "reference" && ref.id.toLowerCase() === packageId.toLowerCase()
	);
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
	vulnerable: PackageEntry[];
	outdated: PackageEntry[];
	deprecated: PackageEntry[];
	patch: PackageEntry[];
	installed: PackageEntry[];
	provenProjects: string[];
	unreadableProjects: string[];
	/** Set when dotnet could not read the target at all. */
	unreadable?: string;
	loadError?: string;
}

const LIST_NAMES = ["vulnerable", "outdated", "deprecated", "patch", "installed"] as const;

async function scanOneTarget(
	cli: DotnetCli,
	targetPath: string,
	label: string,
	signal: AbortSignal
): Promise<TargetScan> {
	const prerelease = ScanState.includePrerelease();
	const settled = await Promise.allSettled([
		cli.listVulnerableReport(targetPath, true, signal),
		cli.listOutdatedReport(targetPath, false, "latest", signal, prerelease),
		cli.listDeprecatedReport(targetPath, signal),
		cli.listOutdatedReport(targetPath, false, "patch", signal, prerelease),
		cli.listInstalled(targetPath, signal),
	]);

	if (settled.some((result) =>
		result.status === "rejected"
		&& errorText(result.reason).includes("`dotnet` was not found")
	)) {
		throw new Error("`dotnet` was not found. Is the .NET SDK installed?");
	}

	const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length === LIST_NAMES.length) {
		const message = errorText(failures[0].reason);
		const empty: TargetScan = {
			vulnerable: [],
			outdated: [],
			deprecated: [],
			patch: [],
			installed: [],
			provenProjects: [],
			unreadableProjects: [],
		};
		if (isProjectLoadFailure(message)) {
			return { ...empty, loadError: message };
		}
		return { ...empty, unreadable: message };
	}

	const reports: PackageListResult[] = LIST_NAMES.map((name, index) => {
		const result = settled[index];
		if (result.status === "fulfilled") {
			return result.value;
		}

		if (!signal.aborted) {
			const kind = result.reason instanceof TargetUnreadableError ? "unreadable" : "failed";
			logger.error(`[${label}] ${name} list ${kind}: ${errorText(result.reason)}`);
		}
		return emptyPackageList();
	});

	// Some SDK builds fail on --highest-patch. Build the list from the local version cache.
	if (settled[3].status === "rejected" && settled[1].status === "fulfilled") {
		const fallback = await highestPatchFromLocal(reports[1].packages, prerelease);
		reports[3] = {
			...emptyPackageList(),
			entries: fallback.flatMap((pkg) => (pkg.entries || []).map((entry) => ({ ...entry, latestVersion: pkg.latestVersion }))),
		};
		if (fallback.length > 0) {
			logger.info(`[${label}] highest patch read from the local version list for ${fallback.length} packages.`);
		}
	}

	const unreadableProjects = [...new Set(reports.flatMap((report) => report.unreadableProjects))];
	const proofReady = [0, 1, 2, 4].every((index) => settled[index].status === "fulfilled");
	const provenProjects = proofReady
		? provenProjectNames([
			reports[4].projects,
			reports[0].projects,
			reports[1].projects,
			reports[2].projects,
		]).filter((name) => !unreadableProjects.some((item) => item.toLowerCase() === name.toLowerCase()))
		: [];

	return {
		vulnerable: reports[0].entries,
		outdated: reports[1].entries,
		deprecated: reports[2].entries,
		patch: reports[3].entries,
		installed: reports[4].entries,
		provenProjects,
		unreadableProjects,
	};
}

function attachHighestPatch(groups: PackageInfo[][], patch: PackageInfo[]): void {
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

function dedupeEntries(entries: PackageEntry[]): PackageEntry[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = [pathKey(entry.projectPath || entry.projectName), entry.framework, entry.id, entry.isTransitive ? "t" : "d"]
			.join("\n").toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function groupByProject(entries: PackageEntry[]): Map<string, PackageEntry[]> {
	const grouped = new Map<string, PackageEntry[]>();
	for (const entry of entries) {
		if (!entry.projectPath) {
			continue;
		}
		const list = grouped.get(entry.projectPath) ?? [];
		list.push(entry);
		grouped.set(entry.projectPath, list);
	}
	return grouped;
}

/**
 * Restores the solutions or projects that hold the given projects. An empty
 * list restores nothing. Throws when any restore fails.
 */
async function restoreForProjects(projectPaths: string[], signal?: AbortSignal): Promise<void> {
	if (projectPaths.length === 0) {
		return;
	}

	const found = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
	const membership = await readSolutionProjects(classicSolutionPaths(found));
	for (const solution of membership) {
		if (solution.error) {
			logger.error(`Could not read the solution (${solution.solutionPath}): ${solution.error}`);
		}
	}

	const failures: string[] = [];
	for (const target of restoreTargetsForProjects(membership, projectPaths)) {
		try {
			await dotnetCli.restore(target, signal);
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			failures.push(`${path.basename(target)}: ${errorText(error)}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Restore failed.\n${failures.join("\n")}`);
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

function showFailure(prefix: string, error: unknown): void {
	const message = errorText(error);
	logger.show(true);
	logger.error(`${prefix}: ${message}`);
	const [first, ...rest] = message.split(/\r?\n/);
	void vscode.window.showErrorMessage(`${prefix}: ${first}`, {
		modal: rest.length > 0,
		detail: rest.length > 0 ? rest.join("\n") : undefined,
	});
}

interface WriteTarget {
	packageId: string;
	version: string;
	projectPath: string;
	projectName: string;
}

/**
 * Writes one version for one package in one project, as planned from the
 * MSBuild evaluation. Returns the files edited directly.
 */
async function applyVersionEdit(plan: EditPlan, target: WriteTarget, editedFiles: Set<string>): Promise<void> {
	if (plan.kind === "dotnet-add") {
		await dotnetCli.updatePackage(target.projectPath, target.packageId, target.version);
		return;
	}

	const key = `${pathKey(plan.filePath)}\n${target.packageId.toLowerCase()}`;
	if (editedFiles.has(key)) {
		return;
	}
	const uri = vscode.Uri.file(plan.filePath);
	const document = await vscode.workspace.openTextDocument(uri);
	const text = document.getText();
	const next = setPackageVersionInXml(text, plan.tag, target.packageId, plan.attribute, target.version);
	if (next === undefined) {
		throw new Error(`${path.basename(plan.filePath)} has no ${plan.tag} ${plan.attribute} for ${target.packageId}. Nothing was written.`);
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), next);
	ownSaves.add(pathKey(plan.filePath));
	try {
		if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
			throw new Error(`${path.basename(plan.filePath)} could not be written.`);
		}
	} finally {
		setTimeout(() => ownSaves.delete(pathKey(plan.filePath)), 1500);
	}
	editedFiles.add(key);
}

/**
 * Writes every target, then restores the touched projects. Each failure is
 * reported with dotnet's exit code and error lines. Success is reported only
 * for what really succeeded.
 */
async function writeTargets(label: string, targets: WriteTarget[], progress: vscode.Progress<{ message?: string }>): Promise<{ written: WriteTarget[]; failed: string[] }> {
	const written: WriteTarget[] = [];
	const failed: string[] = [];
	const editedFiles = new Set<string>();
	for (const target of targets) {
		progress.report({ message: `${target.packageId} → ${target.version} (${target.projectName})` });
		try {
			const evaluation = await evaluationFor(target.projectPath).catch(() => undefined);
			await applyVersionEdit(planVersionEdit(evaluation, target.projectPath, target.packageId), target, editedFiles);
			written.push(target);
		} catch (error) {
			failed.push(`${target.packageId} in ${target.projectName}: ${errorText(error)}`);
			logger.error(`${label}: ${target.packageId} in ${target.projectName} failed: ${errorText(error)}`);
		}
	}

	forgetEvaluations();
	if (written.length > 0) {
		progress.report({ message: "Restore is running..." });
		try {
			await restoreForProjects([...new Set(written.map((target) => target.projectPath))]);
		} catch (error) {
			failed.push(errorText(error));
		}
	}
	return { written, failed };
}

function reportWriteResult(label: string, written: number, total: number, failed: string[]): void {
	if (failed.length === 0) {
		void vscode.window.showInformationMessage(`${label}: updated ${written} of ${total}.`);
		return;
	}
	logger.show(true);
	void vscode.window.showErrorMessage(
		written > 0
			? `${label}: ${written} of ${total} written, but something failed. Nothing below was updated.`
			: `${label} failed. Nothing was updated.`,
		{ modal: true, detail: failed.join("\n\n") }
	);
}

async function applySafeUpdate(channel: "patch" | "minor"): Promise<void> {
	const projects = await workspaceScanner.findProjects();
	if (projects.length === 0) {
		vscode.window.showErrorMessage("No .csproj or .fsproj file was found in the workspace.");
		return;
	}

	const label = channel === "patch" ? "Highest patch" : "Highest minor";
	const targets: (WriteTarget & { from: string })[] = [];
	let blocked = false;
	const prerelease = ScanState.includePrerelease();

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			for (const project of projects) {
				if (blocked) {
					return;
				}

				const projectName = workspaceScanner.getProjectName(project);
				progress.report({ message: `Reading ${label}: ${projectName}` });

				let listed: PackageInfo[];
				try {
					listed = await dotnetCli.listOutdated(project.fsPath, false, channel, undefined, prerelease);
				} catch (error) {
					const message = errorText(error);
					logger.error(`Could not read the ${label} list (${project.fsPath}): ${message}`);
					if (message.includes("`dotnet` was not found")) {
						blocked = true;
						vscode.window.showErrorMessage(message);
						return;
					}
					if (channel !== "patch") {
						continue;
					}
					try {
						const latest = await dotnetCli.listOutdated(project.fsPath, false, "latest", undefined, prerelease);
						listed = await highestPatchFromLocal(latest, prerelease);
					} catch {
						continue;
					}
				}
				for (const pkg of listed) {
					const from = pkg.resolvedVersion || pkg.version;
					if (!pkg.latestVersion || !isSafeChannelTarget(from, pkg.latestVersion, channel)) {
						continue;
					}
					if (!isValidPackageId(pkg.id) || !isValidPackageVersion(pkg.latestVersion)) {
						continue;
					}

					targets.push({
						packageId: pkg.id,
						from,
						version: pkg.latestVersion,
						projectPath: project.fsPath,
						projectName,
					});
				}
			}
		}
	);

	if (blocked) {
		return;
	}

	if (targets.length === 0) {
		vscode.window.showInformationMessage(`No packages to update for ${label}. Major versions and prereleases are not written.`);
		return;
	}

	const preview = targets
		.slice(0, 15)
		.map((target) => `${target.packageId} ${target.from} → ${target.version} (${target.projectName}, ${versionChange(target.from, target.version)})`);
	const extra = targets.length > 15 ? `\n… and ${targets.length - 15} more` : "";
	const confirm = await vscode.window.showWarningMessage(
		`${label}: ${targets.length} update${targets.length === 1 ? "" : "s"}`,
		{
			modal: true,
			detail: `${preview.join("\n")}${extra}\n\nMajor versions and prereleases are not written.`,
		},
		"Yes, Update"
	);

	if (confirm !== "Yes, Update") {
		return;
	}

	await writeQueue.run(async () => vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			const { written, failed } = await writeTargets(label, targets, progress);
			logger.info(`${label}: ${written.length} of ${targets.length} written.`);
			reportWriteResult(label, written.length, targets.length, failed);
			if (written.length > 0) {
				await vscode.commands.executeCommand("packageHub.scanWorkspace");
			}
		}
	));
}

function paintScanStatus(item: vscode.StatusBarItem): void {
	const status = ScanState.statusBarLabel();
	item.text = status.text;
	item.tooltip = status.neutral
		? "PackageHub – No .NET project was scanned. Click to open the Health Dashboard"
		: "PackageHub – Click to open the Health Dashboard";
	item.backgroundColor = status.healthy
		? undefined
		: new vscode.ThemeColor("statusBarItem.warningBackground");
}

function activeLineRef(): ReturnType<typeof packageRefAtLine> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	return packageRefAtLine(editor.document.getText(), editor.selection.active.line);
}

/**
 * Projects that hold the package, from every list of the last scan. Direct
 * and transitive are kept apart.
 */
function packageProjects(packageId: string): { name: string; path?: string; relation: "direct" | "transitive"; version?: string }[] {
	const found = ScanState.findPackage(packageId);
	const installed = ScanState.findInstalled(packageId);
	const raw = ScanState.getAllVulnerable().find((pkg) => pkg.id.toLowerCase() === packageId.toLowerCase());
	const sources = [installed, raw, found.vulnerable, found.outdated, found.deprecated].filter(
		(pkg): pkg is PackageInfo => !!pkg
	);
	const result = new Map<string, { name: string; path?: string; relation: "direct" | "transitive"; version?: string }>();
	for (const pkg of sources) {
		const direct = new Set((pkg.directProjects ?? directProjectNames(pkg)).map((name) => name.toLowerCase()));
		for (const name of pkg.projects || []) {
			const key = name.toLowerCase();
			const relation = direct.has(key) ? "direct" : "transitive";
			const known = result.get(key);
			if (known && (known.relation === "direct" || relation === "transitive")) {
				continue;
			}
			result.set(key, {
				name,
				path: pkg.projectPaths?.[name] ?? known?.path,
				relation,
				version: pkg.versionByProject?.[name] ?? known?.version ?? pkg.version,
			});
		}
	}
	return [...result.values()];
}

export function activate(context: vscode.ExtensionContext) {
	dotnetCli = new DotnetCli(dotnetTimeouts);
	workspaceScanner = new WorkspaceScanner();
	processSlots.setLimit(maxDotnetProcesses());
	context.subscriptions.push(workspaceScanner.watch());
	context.subscriptions.push(dotnetCli.onOutput((output) => {
		recordFeedFailures(parseFeedFailures(`${output.stdout}\n${output.stderr}`));
	}));
	void vscode.commands.executeCommand("setContext", "packageHub.scanCompleted", false);

	// Status bar
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	statusBarItem.tooltip = "PackageHub – Click to open the Health Dashboard";
	statusBarItem.show();
	statusBarItem.command = "packageHub.showHealthDashboard";
	context.subscriptions.push(statusBarItem);

	// Tree view
	const treeProvider = new PackageHubTreeProvider(workspaceScanner);
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

		if (event.affectsConfiguration("packageHub.maxDotnetProcesses")) {
			processSlots.setLimit(maxDotnetProcesses());
		}

		if (event.affectsConfiguration("packageHub.onlineLookups")) {
			HealthDashboardPanel.refreshIfOpen();
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

	void workspaceScanner.findProjects()
		.then(async (projects) => {
			void workspaceScanner.countScanTargets().then((found) =>
				vscode.commands.executeCommand("setContext", "packageHub.hasProjects", found.targets > 0)
			);
			const logs = await readRestoreLogs(projects.map((project) => project.fsPath));
			ScanState.setAuditDataGap(logs.auditDataGap);
			recordFeedFailures(logs.feedFailures);
			paintScanStatus(statusBarItem);
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`Could not read the restore logs: ${error.message}`);
		});

	// The hover explains. Update links read the lightbulb cache and do not start a new dotnet call.
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ scheme: "file", pattern: "**/*.{csproj,fsproj,props}" }
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
	const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,sln}", false, true, false);
	// Clear the project cache first so the view does not read a stale list.
	const projectsChanged = () => {
		workspaceScanner.invalidate();
		treeProvider.refresh();
	};
	projectWatcher.onDidCreate(projectsChanged);
	projectWatcher.onDidDelete(projectsChanged);
	context.subscriptions.push(
		projectWatcher,
		// Adding or removing a workspace folder changes what can be scanned without creating a file.
		vscode.workspace.onDidChangeWorkspaceFolders(projectsChanged)
	);

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
			HealthDashboardPanel.createOrShow(context.extensionUri);
		}
	);

	// ======================
	// Commands
	// ======================

	async function updateActiveLine(channel: "patch" | "latest"): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const ref = activeLineRef();
		if (!editor || !ref) {
			vscode.window.showWarningMessage("No package was found on this line.");
			return;
		}

		const projectName = isMsBuildProject(editor.document.fileName)
			? workspaceScanner.getProjectName(editor.document.uri)
			: undefined;
		const found = ScanState.findPackage(ref.id);
		const current = ScanState.resolvedVersionIn(ref.id, projectName)
			|| (ref.kind === "version" ? ref.version : undefined)
			|| (!ref.version ? ScanState.getCentralVersion(ref.id) : ref.version)
			|| found.vulnerable?.version
			|| found.outdated?.version;
		const peek = await codeActionProvider.peekUpdateTargets(editor.document, ref.id, current);
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
			projectName,
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
				const inProjectFile = !!editor && isPackageDocumentPath(editor.document.fileName);
				const fromLine = activeLineRef()?.id;
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

			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage("That is not a valid package id.");
				return;
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
			const id = packageId;

			if (current.some((item) => item.toLowerCase() === id.toLowerCase())) {
				vscode.window.showInformationMessage(`${id} is already in the ignore list.`);
				return;
			}

			await config.update("ignoredPackages", [...current, id], vscode.ConfigurationTarget.Workspace);

			vscode.window.showInformationMessage(
				`${id} is hidden from PackageHub lists. The build warning stays.`
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

				const ref = activeLineRef();
				if (!ref) {
					vscode.window.showWarningMessage(
						"No PackageReference was found on this line."
					);
					return;
				}

				const packageId = ref.id;
				const { vulnerable, outdated, deprecated } = ScanState.findPackage(packageId);
				const info = vulnerable || outdated || deprecated;

				if (!info) {
					vscode.window.showInformationMessage(
						`${packageId} has no known issue in the last scan (or no scan has run yet).`
					);
					return;
				}

				const lines = [
					`${packageId}`,
					info.version ? `Current: ${info.version}` : undefined,
					info.latestVersion ? `Suggested: ${info.latestVersion}` : undefined,
					info.severity ? `Severity: ${info.severity}` : undefined,
					vulnerable ? "Status: Vulnerable" : undefined,
					!vulnerable && deprecated ? "Status: Deprecated" : undefined,
					!vulnerable && !deprecated && outdated ? "Status: Outdated" : undefined,
					info.projects?.length ? `Projects: ${info.projects.join(", ")}` : undefined,
				].filter(Boolean);

				const buttons: string[] = [];
				const advisory = info.advisoryUrl?.startsWith("https://") ? info.advisoryUrl : undefined;
				if (advisory) {
					buttons.push("Open Advisory");
				}
				if (info.latestVersion) {
					buttons.push("Update");
				}

				const action = await vscode.window.showInformationMessage(
					lines.join(" | "),
					...buttons
				);

				if (action === "Open Advisory" && advisory) {
					await vscode.env.openExternal(vscode.Uri.parse(advisory));
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
					workspaceScanner.invalidate();
					resetFeedFailures();

					const skipped: string[] = [];
					const unreadable: string[] = [];
					const provenNames: string[] = [];
					const unreadableProjects: string[] = [];
					const buckets = {
						vulnerable: [] as PackageEntry[],
						outdated: [] as PackageEntry[],
						deprecated: [] as PackageEntry[],
						patch: [] as PackageEntry[],
						installed: [] as PackageEntry[],
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
						for (const name of lists.unreadableProjects) {
							if (!unreadableProjects.some((item) => item.toLowerCase() === name.toLowerCase())) {
								unreadableProjects.push(name);
							}
						}
					};

					const scanProjectPaths = async (projectPaths: string[]) => {
						await runPool(projectPaths.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
							const projectPath = projectPaths[index];
							const label = projectNameFromPath(projectPath);
							progress.report({ message: `${index + 1}/${projectPaths.length} ${label}` });
							try {
								const lists = await scanOneTarget(dotnetCli, projectPath, label, abort.signal);
								if (lists.loadError) {
									skipped.push(projectPath);
									logger.info(`Skipped ${projectPath}. ${projectLoadSummary(lists.loadError)}`);
									return;
								}
								if (lists.unreadable) {
									unreadable.push(projectPath);
									unreadableProjects.push(label);
									logger.error(`dotnet could not read ${projectPath}: ${lists.unreadable}`);
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
						logger.info(`.slnx is not scanned as one target. Its projects are scanned one by one: ${slnx}`);
					}
					const solutionMembership = await readSolutionProjects(classicSolutionPaths(foundSolutions));
					const allProjects = (await workspaceScanner.findProjects()).map((project) => project.fsPath);
					const plan = planScanTargets(solutionMembership, allProjects);
					for (const solution of plan.skippedSolutions) {
						logger.info(`Skipped ${path.basename(solution)}: another solution already covers its projects.`);
					}

					if (token.isCancellationRequested) {
						logger.info("Scan cancelled. Results were not drawn.");
						return;
					}

					if (plan.solutions.length === 0 && plan.projects.length === 0) {
						void vscode.commands.executeCommand("setContext", "packageHub.hasProjects", false);
						ScanState.setResults([], [], [], undefined, [], []);
						paintScanStatus(statusBarItem);
						treeProvider.refresh();
						vscode.window.showErrorMessage(
							"No .sln, .csproj, or .fsproj file was found in the workspace."
						);
						return;
					}
					void vscode.commands.executeCommand("setContext", "packageHub.hasProjects", true);

					await runPool(plan.solutions.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
						const targetPath = plan.solutions[index];
						const label = path.basename(targetPath);
						progress.report({ message: `${index + 1}/${plan.solutions.length} ${label}` });

						try {
							const lists = await scanOneTarget(dotnetCli, targetPath, label, abort.signal);
							if (!lists.loadError && !lists.unreadable) {
								remember(lists);
								return;
							}

							logger.info(`The solution could not be read in one pass. Scanning its projects: ${targetPath}`);
							const projects = solutionMembership.find((item) => item.solutionPath === targetPath)?.projects ?? [];
							if (projects.length === 0) {
								logger.error(`Could not scan the solution (${targetPath}): ${projectLoadSummary(lists.loadError || lists.unreadable || "")}`);
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

					await scanProjectPaths(plan.projects);

					if (token.isCancellationRequested) {
						logger.info("Scan cancelled. Results were not drawn.");
						return;
					}

					const vulnerableEntries = dedupeEntries(buckets.vulnerable);
					const outdatedEntries = dedupeEntries(buckets.outdated);
					const patchEntries = dedupeEntries(buckets.patch);
					let vulnerable = aggregatePackages(vulnerableEntries, "vulnerable");
					let outdated = aggregatePackages(outdatedEntries, "outdated");
					let deprecated = aggregatePackages(dedupeEntries(buckets.deprecated), "deprecated");
					const patch = aggregatePackages(patchEntries, "outdated");

					if (skipped.length > 0) {
						const names = skipped.slice(0, 3).map((item) => projectNameFromPath(item));
						const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
						vscode.window.showWarningMessage(
							`PackageHub skipped ${skipped.length} project${skipped.length === 1 ? "" : "s"} that dotnet could not load: ${names.join(", ")}${extra}. The other projects were scanned.`
						);
					}
					if (unreadable.length > 0) {
						const names = unreadable.slice(0, 3).map((item) => projectNameFromPath(item));
						vscode.window.showWarningMessage(
							`dotnet could not read ${names.join(", ")}${unreadable.length > 3 ? ` and ${unreadable.length - 3} more` : ""}. Those projects are not marked healthy. Run Restore All and see the Output panel.`
						);
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
					const installed = aggregatePackages(dedupeEntries(buckets.installed), "installed")
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
					ScanState.setUnreadableProjects(unreadableProjects);

					// Local data first. No request leaves this machine unless packageHub.onlineLookups is on.
					const cacheRoot = await resolveHttpCacheRoot();
					setHttpCacheRoot(cacheRoot);
					try {
						await refreshAdvisoryCatalog({ cacheRoot, online: onlineLookupsEnabled() });
					} catch (advisoryError: any) {
						logger.info(`Advisory ranges were not loaded: ${advisoryError.message}`);
					}

					try {
						await loadReleaseAges(cacheRoot);
					} catch (ageError: any) {
						logger.error(`Could not read the publish dates: ${ageError.message}`);
					}

					treeProvider.refresh();

					const projectEvaluations: ProjectEvaluation[] = [];
					for (const projectPath of allProjects) {
						try {
							projectEvaluations.push(await evaluationFor(projectPath, abort.signal));
						} catch (evaluationError: any) {
							if (abort.signal.aborted) {
								throw evaluationError;
							}
							logger.info(`Could not evaluate ${path.basename(projectPath)}: ${evaluationError.message}`);
						}
					}

					try {
						await refreshCentralPackages(workspaceScanner, projectEvaluations);
					} catch (cpmError: any) {
						logger.error(`Could not read CPM: ${cpmError.message}`);
					}

					try {
						await refreshFeedSources(dotnetCli, workspaceScanner);
					} catch (sourceError: any) {
						logger.error(`Could not read the package sources: ${sourceError.message}`);
					}

					try {
						const logs = await readRestoreLogs(allProjects);
						ScanState.setAuditDataGap(logs.auditDataGap);
						recordFeedFailures(logs.feedFailures);
					} catch (logError: any) {
						logger.error(`Could not read the restore logs: ${logError.message}`);
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
					void vscode.commands.executeCommand("setContext", "packageHub.scanCompleted", true);

					HealthDashboardPanel.refreshIfOpen();
					treeProvider.refresh();

					codeActionProvider.clearCache();
					const patchByProject = groupByProject(patchEntries);
					for (const [projectPath, entries] of groupByProject(outdatedEntries)) {
						codeActionProvider.seed(
							projectPath,
							aggregatePackages(patchByProject.get(projectPath) ?? [], "outdated"),
							aggregatePackages(entries, "outdated"),
							false
						);
					}
					const transitiveVulnerable = new Set(
						vulnerableEntries.filter((entry) => entry.isTransitive).map((entry) => pathKey(entry.projectPath))
					);
					codeLensProvider.refresh();
					lineDecorations.refresh();
					try {
						await auditDiagnostics.refresh();
						void codeActionProvider.prefetch(
							auditDiagnostics.affectedProjects(),
							(projectPath) => transitiveVulnerable.has(pathKey(projectPath))
						).finally(() => {
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
			HealthDashboardPanel.setScanning(true);
			try {
				do {
					await performWorkspaceScan();
				} while (scanGate.end());
			} catch (error) {
				scanGate.forceIdle();
				throw error;
			} finally {
				HealthDashboardPanel.setScanning(false);
				HealthDashboardPanel.refreshIfOpen();
			}
		}
	);

	const updateCommand = vscode.commands.registerCommand(
		"packageHub.updateVulnerable",
		async (args?: { packageId?: unknown; version?: unknown; projectName?: unknown; projects?: unknown }) => {
			const packageId = args?.packageId;
			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage("The package update details are missing or invalid.");
				return;
			}
			const version = typeof args?.version === "string" && args.version ? args.version : undefined;
			if (version !== undefined && !isValidPackageVersion(version)) {
				vscode.window.showWarningMessage(`"${version}" is not an exact NuGet version. The update was not started.`);
				return;
			}
			const projectName = typeof args?.projectName === "string" ? args.projectName : undefined;
			const scope = projectScope(args?.projects);

			// Every project the scan saw this package in, from all lists.
			let related = packageProjects(packageId);
			if (projectName) {
				related = related.filter((item) => item.name.toLowerCase() === projectName.toLowerCase());
			}
			if (scope) {
				related = related.filter((item) => scope.has(item.name.toLowerCase()));
			}

			const allProjects = await workspaceScanner.findProjects();
			const resolveUri = (item: { name: string; path?: string }) =>
				allProjects.find((project) => item.path
					? pathKey(project.fsPath) === pathKey(item.path)
					: workspaceScanner.getProjectName(project).toLowerCase() === item.name.toLowerCase());
			const matched = related
				.map((item) => ({ ...item, uri: resolveUri(item) }))
				.filter((item): item is typeof item & { uri: vscode.Uri } => !!item.uri);
			// Never move a project to an older version than it already has.
			const { kept: targets, skipped: newerProjects } = withoutDowngrades(
				matched,
				version,
				(target) => ScanState.resolvedVersionIn(packageId, target.name) || target.version
			);

			if (targets.length === 0 && newerProjects.length > 0) {
				vscode.window.showInformationMessage(
					`${packageId} is already at ${version} or newer in ${newerProjects.map((item) => item.name).join(", ")}. Nothing was updated.`
				);
				return;
			}

			if (targets.length === 0) {
				vscode.window.showWarningMessage(
					`No project was matched for ${packageId}. Nothing was updated, and no restore was run.`
				);
				logger.error(`Update cancelled: no matching project → ${packageId}`);
				return;
			}

			if (!version) {
				const cont = await vscode.window.showWarningMessage(
					`No newer version was suggested for ${packageId}.`,
					{
						modal: true,
						detail: `A newer version may not exist under the same package id (for example xunit → xunit.v3).\nRun "dotnet add package ${packageId}" anyway?`,
					},
					"Try anyway"
				);

				if (cont !== "Try anyway") {
					return;
				}
			}

			const found = ScanState.findPackage(packageId);
			const vulnerable = found.vulnerable;
			const advisories: UpdateSummaryAdvisory[] = [];
			if (vulnerable && version) {
				for (const url of vulnerable.advisoryUrls?.length ? vulnerable.advisoryUrls : vulnerable.advisoryUrl ? [vulnerable.advisoryUrl] : []) {
					advisories.push({ url, label: advisoryLabel(url), verdict: advisoryVerdict(packageId, url, version) });
				}
			}
			const plans: EditPlan[] = [];
			for (const target of targets) {
				const evaluation = await evaluationFor(target.uri.fsPath).catch(() => undefined);
				plans.push(planVersionEdit(evaluation, target.uri.fsPath, packageId));
			}
			const centralFiles = [...new Set(plans
				.filter((plan): plan is Extract<EditPlan, { kind: "xml-edit" }> => plan.kind === "xml-edit")
				.map((plan) => vscode.workspace.asRelativePath(plan.filePath)))];
			const summaryProjects: UpdateSummaryProject[] = targets.map((target) => ({
				name: target.name,
				fromVersion: ScanState.resolvedVersionIn(packageId, target.name) || target.version,
				relation: target.relation,
			}));
			const summary = buildUpdateSummary({
				packageId,
				targetVersion: version,
				projects: summaryProjects,
				advisories,
				centralFiles,
				usesCentralPackageManagement: ScanState.getCpm(),
				releaseAgeNotice: version ? releaseAgeNotice(packageId, version) : undefined,
				youngerThanAgeGate: version ? !latestReleasePreferred(packageId, version) : false,
			});
			if (newerProjects.length > 0) {
				summary.lines.push(`Left as is, already newer than ${version}: ${newerProjects.map((item) => `${item.name} ${item.from}`).join(", ")}.`);
			}

			const confirm = await vscode.window.showWarningMessage(
				summary.heading,
				{ modal: true, detail: summary.lines.join("\n") },
				"Yes, Update"
			);
			if (confirm !== "Yes, Update") {
				return;
			}

			const transitive = targets.filter((target) => target.relation === "transitive");
			if (transitive.length > 0) {
				const pin = await vscode.window.showWarningMessage(
					`Pin transitive ${packageId}?`,
					{
						modal: true,
						detail: `${packageId} is not referenced directly in ${transitive.map((target) => target.name).join(", ")}. `
							+ `PackageHub will add a direct PackageReference${version ? ` at ${version}` : ""} there. `
							+ "That pin stays after the parent package changes, until you remove it.",
					},
					"Yes, Pin"
				);
				if (pin !== "Yes, Pin") {
					return;
				}
			}

			await writeQueue.run(async () => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					const writeTargetsList: WriteTarget[] = targets.map((target) => ({
						packageId,
						version: version ?? "",
						projectPath: target.uri.fsPath,
						projectName: target.name,
					}));
					if (!version) {
						const failed: string[] = [];
						let written = 0;
						for (const target of writeTargetsList) {
							progress.report({ message: `${packageId} → latest (${target.projectName})` });
							try {
								await dotnetCli.updatePackage(target.projectPath, packageId);
								written += 1;
							} catch (error) {
								failed.push(`${target.projectName}: ${errorText(error)}`);
							}
						}
						forgetEvaluations();
						if (written > 0) {
							try {
								await restoreForProjects(writeTargetsList.map((target) => target.projectPath));
							} catch (error) {
								failed.push(errorText(error));
							}
						}
						reportWriteResult(`${packageId}`, written, writeTargetsList.length, failed);
						if (written > 0) {
							await vscode.commands.executeCommand("packageHub.scanWorkspace");
						}
						return;
					}

					const { written, failed } = await writeTargets(`${packageId} → ${version}`, writeTargetsList, progress);
					logger.info(`${packageId} → ${version}: ${written.length} of ${writeTargetsList.length} written.`);
					reportWriteResult(`${packageId} → ${version}`, written.length, writeTargetsList.length, failed);
					if (written.length > 0) {
						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					}
				}
			));
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
				packageId = activeLineRef()?.id || "";
			}

			if (!packageId) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}
			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage("That is not a valid package id. Removal was not started.");
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
				const direct = new Set(packageProjects(packageId)
					.filter((item) => item.relation === "direct")
					.map((item) => item.name.toLowerCase()));
				targets = allProjects.filter((project) =>
					direct.has(workspaceScanner.getProjectName(project).toLowerCase())
				);
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
				`Remove ${packageId}?`,
				{ modal: true, detail: projectNames },
				"Yes, Remove"
			);
			if (confirm !== "Yes, Remove") {
				return;
			}

			await writeQueue.run(async () => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					let removed = 0;
					const failed: string[] = [];
					for (const project of targets) {
						progress.report({
							message: `${packageId} removing → ${workspaceScanner.getProjectName(project)}`,
						});
						try {
							await dotnetCli.removePackage(project.fsPath, packageId);
							removed += 1;
						} catch (error) {
							failed.push(`${workspaceScanner.getProjectName(project)}: ${errorText(error)}`);
						}
					}
					forgetEvaluations();
					logger.info(`Removed ${packageId} from ${removed} of ${targets.length} projects.`);
					if (failed.length === 0) {
						vscode.window.showInformationMessage(`${packageId} was removed.`);
					} else {
						logger.show(true);
						vscode.window.showErrorMessage(
							`Remove failed for ${failed.length} of ${targets.length} projects.`,
							{ modal: true, detail: failed.join("\n\n") }
						);
					}
					if (removed > 0) {
						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					}
				}
			));
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
			const ref = activeLineRef();
			if (!ref) {
				vscode.window.showWarningMessage("No package was found on this line.");
				return;
			}

			const url = advisorySuppressUrl(ref.id);
			if (!url) {
				vscode.window.showWarningMessage("No advisory link for this package.");
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
			const info = vulnerable || outdated || deprecated || ScanState.findInstalled(item.packageId);
			const version = info?.version || (typeof item.version === "string" ? item.version : undefined);

			const lines = [
				`Package: ${item.packageId}`,
				version ? `Current: ${version}` : undefined,
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
			if (!isValidPackageId(item?.packageId)) {
				vscode.window.showWarningMessage("Could not select a package.");
				return;
			}

			// Opens the browser. PackageHub itself does not fetch the page.
			const url = vscode.Uri.parse(`https://www.nuget.org/packages/${encodeURIComponent(item.packageId)}`);
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

			const projects = await workspaceScanner.findProjects();
			if (projects.length === 0) {
				vscode.window.showErrorMessage("No .csproj or .fsproj was found to restore.");
				return;
			}

			await writeQueue.run(async () => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					progress.report({ message: "Restore is running..." });

					try {
						await restoreForProjects(projects.map((project) => project.fsPath));
						vscode.window.showInformationMessage("Restore finished.");
					} catch (error) {
						showFailure("Restore failed", error);
					}
					await vscode.commands.executeCommand("packageHub.scanWorkspace");
				}
			));
		}
	);

	const showGraphCommand = vscode.commands.registerCommand(
		"packageHub.showDependencyGraph",
		async (args?: { packageId?: string }) => {
			let packageId = typeof args?.packageId === "string" ? args.packageId.trim() : "";
			if (!packageId) {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					packageId = activeLineRef()?.id || "";
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
				packageId = activeLineRef()?.id || "";
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
		async (url?: unknown) => {
			if (typeof url !== "string" || !url.startsWith("https://")) {
				vscode.window.showWarningMessage("No advisory link.");
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const quickFixBlockedCommand = vscode.commands.registerCommand(
		"packageHub.quickFixBlocked",
		async (message?: unknown) => {
			vscode.window.showWarningMessage(
				typeof message === "string" && message ? message.slice(0, 300) : "No patch version. The update was not started."
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

	// A changed project or props file makes the MSBuild evaluation stale.
	const evaluationWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,props,targets}");
	evaluationWatcher.onDidChange(() => forgetEvaluations());
	evaluationWatcher.onDidCreate(() => forgetEvaluations());
	evaluationWatcher.onDidDelete(() => forgetEvaluations());
	context.subscriptions.push(evaluationWatcher);

	// Saving several files at once starts one restore and one scan, 500 ms after the last save.
	const saveScan = new Debouncer<string>(500, (paths) => {
		void writeQueue.run(async () => {
			forgetEvaluations();
			const projects = (await workspaceScanner.findProjects()).map((project) => project.fsPath);
			const affected = projects.filter((projectPath) => paths.some((saved) => {
				if (isMsBuildProject(saved)) {
					return pathKey(saved) === pathKey(projectPath);
				}
				// A props file applies to the projects under its folder.
				const folder = pathKey(path.dirname(saved)) + path.sep;
				return pathKey(projectPath).startsWith(folder);
			}));
			if (affected.length > 0) {
				try {
					await restoreForProjects(affected);
				} catch (error) {
					logger.error(`Restore after save failed: ${errorText(error)}`);
					void vscode.window.showWarningMessage(
						"Restore after save failed. The scan shows what dotnet could still read. See the Output panel."
					);
				}
			}
		}).finally(() => {
			void vscode.commands.executeCommand("packageHub.scanWorkspace");
		});
	});
	context.subscriptions.push({ dispose: () => saveScan.dispose() });

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
		if (ownSaves.has(pathKey(document.uri.fsPath))) {
			return;
		}
		saveScan.trigger(document.uri.fsPath);
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
			// Opening the view in a folder without projects or solutions activates the extension too. Do not scan there.
			void workspaceScanner.countScanTargets().then((found) => {
				if (found.targets > 0) {
					void vscode.commands.executeCommand("packageHub.scanWorkspace");
				}
			});
		}, 2000);
	}
}

function packageReferenceLine(text: string, packageId: string): number {
	const id = packageId.toLowerCase();
	const ref = readPackageRefs(text).find((item) => item.kind === "reference" && item.id.toLowerCase() === id);
	return ref ? ref.line : -1;
}

export function deactivate() {
	killAllProcesses();
}
