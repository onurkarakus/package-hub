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
import { isMsBuildProject, isPackageDocumentPath, PACKAGE_DOCUMENT_GLOB, projectNameFromPath } from "./services/projectFiles";
import { provenProjectNames } from "./services/provenProjects";
import {
	planScanTargets,
	readSolutionProjects,
	restoreTargetsForProjects,
	SolutionProjects,
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
import { findNearestFile, planVersionEdit, ProjectEvaluation, setPackageVersionInXml, EditPlan } from "./services/ProjectEvaluation";
import { Debouncer, WriteQueue } from "./services/WriteQueue";
import { buildUpdateSummary, UpdateSummaryAdvisory, UpdateSummaryProject } from "./services/UpdateSummary";
import { highestPatchFromLocal } from "./services/PatchFallback";
import { projectScope, withoutDowngrades } from "./services/UpdateScope";
import { FileSnapshot } from "./services/FileSnapshot";
import { findPropertyDefinition, planVersionWrite, setPropertyInXml } from "./services/VersionSpec";
import {
	defaultGlobalPackagesPath,
	describeUpdateDetails,
	licenseText,
	lowestVersion,
	NuspecInfo,
	parseNuspec,
	readCachedNuspec,
} from "./services/PackageDetails";
import { fetchOnlineText } from "./services/OnlineFetch";
import { isValidSearchQuery, mergeHits, newestVersion, SearchHit, searchLocalPackages, sortVersionsDescending } from "./services/PackageSearch";
import { alignablePackages, AlignPlan, planAlignment } from "./services/Consolidate";
import { findUnusedCentralVersions, removePackageVersionsFromXml } from "./services/UnusedCentralVersions";
import { rollbackEnabled } from "./services/Settings";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

const PROJECT_SCAN_CONCURRENCY = 2;
const scanGate = new ScanGate();
let runningScan: Promise<void> | undefined;
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
		{ placeHolder: vscode.l10n.t("Which project should the suppress entry be written to?") }
	);
	return picked?.uri;
}

async function openSuppressDiff(packageId: string, url: string): Promise<void> {
	const uri = await suppressTarget(packageId);
	if (!uri) {
		vscode.window.showWarningMessage(vscode.l10n.t("No project file was found for this package. The suppress entry was not written."));
		return;
	}

	const document = await vscode.workspace.openTextDocument(uri);
	const text = document.getText();
	if (alreadySuppressed(text, url)) {
		vscode.window.showInformationMessage(vscode.l10n.t("This advisory is already in NuGetAuditSuppress."));
		return;
	}

	const closing = text.lastIndexOf("</Project>");
	if (closing < 0) {
		vscode.window.showErrorMessage(vscode.l10n.t("The project file has no closing tag. The suppress entry was not written."));
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
		vscode.window.showErrorMessage(vscode.l10n.t("The suppress draft could not be opened. The file was not changed."));
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
		vscode.l10n.t("The suppress draft opened in a diff. Save it, then run Restore All. If you do not save, the file stays unchanged.")
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
async function restoreForProjects(projectPaths: string[], signal?: AbortSignal, forceEvaluate = false): Promise<void> {
	if (projectPaths.length === 0) {
		return;
	}

	const found = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
	const membership: SolutionProjects[] = await readSolutionProjects(found);
	for (const solution of membership) {
		if (solution.error) {
			logger.error(`Could not read the solution (${solution.solutionPath}): ${solution.error}`);
		}
	}

	const failures: string[] = [];
	for (const target of restoreTargetsForProjects(membership, projectPaths)) {
		try {
			await dotnetCli.restore(target, signal, forceEvaluate);
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			// Older SDKs cannot restore a .slnx. Restore its projects one by one instead.
			const members = target.toLowerCase().endsWith(".slnx")
				? membership.find((item) => pathKey(item.solutionPath) === pathKey(target))?.projects ?? []
				: [];
			const wanted = members.filter((member) => projectPaths.some((item) => pathKey(item) === pathKey(member)));
			if (wanted.length > 0) {
				logger.info(`dotnet could not restore ${path.basename(target)} as a whole. Restoring its projects one by one.`);
				for (const member of wanted) {
					try {
						await dotnetCli.restore(member, signal, forceEvaluate);
					} catch (memberError) {
						if (signal?.aborted) {
							throw memberError;
						}
						failures.push(`${path.basename(member)}: ${errorText(memberError)}`);
					}
				}
				continue;
			}
			failures.push(`${path.basename(target)}: ${errorText(error)}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`${vscode.l10n.t("Restore failed.")}\n${failures.join("\n")}`);
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

interface WriteContext {
	/** File + package (or file + property) pairs already written in this batch. */
	editedFiles: Set<string>;
	/** Projects whose floating version or range already covers the target: restore only. */
	forceEvaluate: Set<string>;
}

/**
 * Replaces the whole text of a file through the editor, so open editors and
 * undo stay in step. The save does not start another scan.
 */
async function rewriteFile(filePath: string, transform: (text: string) => string | undefined, failure: string): Promise<void> {
	const uri = vscode.Uri.file(filePath);
	const document = await vscode.workspace.openTextDocument(uri);
	const text = document.getText();
	const next = transform(text);
	if (next === undefined) {
		throw new Error(failure);
	}
	if (next === text) {
		return;
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), next);
	ownSaves.add(pathKey(filePath));
	try {
		if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
			throw new Error(vscode.l10n.t("{0} could not be written.", path.basename(filePath)));
		}
	} finally {
		setTimeout(() => ownSaves.delete(pathKey(filePath)), 1500);
	}
}

async function readText(filePath: string | undefined): Promise<string | undefined> {
	if (!filePath) {
		return undefined;
	}
	try {
		return (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).getText();
	} catch {
		return undefined;
	}
}

interface DeclaredVersion {
	filePath: string;
	tag: "PackageVersion" | "GlobalPackageReference" | "PackageReference";
	attribute: "Version" | "VersionOverride";
	raw: string;
}

/**
 * Finds the text written for a package version, before MSBuild expands it:
 * it may be an exact version, a range, a floating version or a property.
 */
async function declaredVersionFor(plan: EditPlan, evaluation: ProjectEvaluation | undefined, target: WriteTarget): Promise<DeclaredVersion | undefined> {
	const id = target.packageId.toLowerCase();
	const lookup = async (filePath: string | undefined, tag: DeclaredVersion["tag"], attribute: DeclaredVersion["attribute"]) => {
		const text = await readText(filePath);
		if (!filePath || text === undefined) {
			return undefined;
		}
		const ref = readPackageRefs(text).find((item) => item.tag === tag && item.id.toLowerCase() === id);
		const raw = attribute === "VersionOverride" ? ref?.versionOverride : ref?.declaredVersion;
		return raw ? { filePath, tag, attribute, raw } : undefined;
	};
	if (plan.kind === "xml-edit") {
		return lookup(plan.filePath, plan.tag, plan.attribute);
	}
	if (evaluation?.cpmEnabled) {
		return lookup(evaluation.propsPath ?? await findNearestFile(path.dirname(target.projectPath), "Directory.Packages.props"), "PackageVersion", "Version");
	}
	return await lookup(target.projectPath, "PackageReference", "Version")
		?? await lookup(await findNearestFile(path.dirname(target.projectPath), "Directory.Build.props"), "PackageReference", "Version");
}

/**
 * The files a property can be defined in for a project, in the order MSBuild
 * reads them: Directory.Build.props, Directory.Packages.props, the project.
 */
async function propertyFiles(target: WriteTarget, evaluation: ProjectEvaluation | undefined): Promise<{ filePath: string; text: string }[]> {
	const candidates = [
		await findNearestFile(path.dirname(target.projectPath), "Directory.Build.props"),
		evaluation?.propsPath ?? await findNearestFile(path.dirname(target.projectPath), "Directory.Packages.props"),
		target.projectPath,
	];
	const files: { filePath: string; text: string }[] = [];
	for (const filePath of candidates) {
		const text = await readText(filePath);
		if (filePath && text !== undefined && !files.some((item) => pathKey(item.filePath) === pathKey(filePath))) {
			files.push({ filePath, text });
		}
	}
	return files;
}

/**
 * Writes one version for one package in one project, as planned from the
 * MSBuild evaluation. Exact versions go through the usual path. A range keeps
 * its upper bound, a floating version that already covers the target only
 * needs a restore, and a $(Property) gets its definition edited.
 */
async function applyVersionEdit(plan: EditPlan, target: WriteTarget, context: WriteContext, evaluation?: ProjectEvaluation): Promise<void> {
	const declared = await declaredVersionFor(plan, evaluation, target);
	let write = declared ? planVersionWrite(declared.raw, target.version) : { kind: "write" as const, text: target.version };

	if (write.kind === "property") {
		const name = write.name;
		const definition = findPropertyDefinition(await propertyFiles(target, evaluation), name);
		if (definition === "conditional") {
			throw new Error(vscode.l10n.t("$({0}) is set under a Condition. Edit it by hand.", name));
		}
		if (!definition) {
			throw new Error(vscode.l10n.t("$({0}) is not defined in the project, Directory.Build.props or Directory.Packages.props. Edit it by hand.", name));
		}
		const key = `${pathKey(definition.filePath)}\n$(${name.toLowerCase()})`;
		if (context.editedFiles.has(key)) {
			return;
		}
		const inner = planVersionWrite(definition.value, target.version);
		if (inner.kind === "refused" || inner.kind === "property") {
			throw new Error(inner.kind === "refused" ? inner.reason : vscode.l10n.t("$({0}) points at another property. Edit it by hand.", name));
		}
		if (inner.kind === "restore-only") {
			context.forceEvaluate.add(pathKey(target.projectPath));
			return;
		}
		await rewriteFile(
			definition.filePath,
			(text) => setPropertyInXml(text, name, inner.text),
			vscode.l10n.t("{0} has no {1} property. Nothing was written.", path.basename(definition.filePath), name)
		);
		logger.info(`${target.packageId}: set $(${name}) to ${inner.text} in ${definition.filePath}.`);
		context.editedFiles.add(key);
		return;
	}

	if (write.kind === "refused") {
		throw new Error(write.reason);
	}
	if (write.kind === "restore-only") {
		logger.info(`${target.packageId} in ${target.projectName}: ${write.reason}`);
		context.forceEvaluate.add(pathKey(target.projectPath));
		return;
	}

	const exact = !declared || write.text === target.version;
	if (exact && plan.kind === "dotnet-add") {
		await dotnetCli.updatePackage(target.projectPath, target.packageId, target.version);
		return;
	}

	const location = declared ?? (plan.kind === "xml-edit" ? { filePath: plan.filePath, tag: plan.tag, attribute: plan.attribute, raw: "" } : undefined);
	if (!location) {
		await dotnetCli.updatePackage(target.projectPath, target.packageId, target.version);
		return;
	}
	const key = `${pathKey(location.filePath)}\n${target.packageId.toLowerCase()}`;
	if (context.editedFiles.has(key)) {
		return;
	}
	const value = write.text;
	await rewriteFile(
		location.filePath,
		(text) => setPackageVersionInXml(text, location.tag, target.packageId, location.attribute, value),
		vscode.l10n.t("{0} has no {1} {2} for {3}. Nothing was written.", path.basename(location.filePath), location.tag, location.attribute, target.packageId)
	);
	context.editedFiles.add(key);
}

/**
 * Every file a write for these targets can touch: the project files, the
 * props files above them, lock files and the files the evaluation names.
 */
async function filesTouchedBy(targets: WriteTarget[]): Promise<string[]> {
	const files = new Set<string>();
	for (const target of targets) {
		files.add(target.projectPath);
		files.add(path.join(path.dirname(target.projectPath), "packages.lock.json"));
		for (const name of ["Directory.Packages.props", "Directory.Build.props", "Directory.Build.targets"]) {
			const found = await findNearestFile(path.dirname(target.projectPath), name);
			if (found) {
				files.add(found);
			}
		}
		const evaluation = await evaluationFor(target.projectPath).catch(() => undefined);
		if (evaluation?.propsPath) {
			files.add(evaluation.propsPath);
		}
		for (const item of [...evaluation?.packageReferences ?? [], ...evaluation?.globalPackageReferences ?? [], ...evaluation?.packageVersions ?? []]) {
			if (item.definingFile && item.id.toLowerCase() === target.packageId.toLowerCase()) {
				files.add(item.definingFile);
			}
		}
	}
	return [...files];
}

interface WriteResult {
	written: WriteTarget[];
	failed: string[];
	/** Set when a failure put every file back as it was before the batch. */
	rolledBack?: { restored: number; notRestored: string[] };
}

/**
 * Writes every target, then restores the touched projects. Each failure is
 * reported with dotnet's exit code and error lines. Success is reported only
 * for what really succeeded.
 *
 * With more than one target, the files are saved first. When a write or the
 * restore after it fails, every file goes back to how it was and nothing of
 * the batch stays half done (packageHub.rollbackOnFailure).
 */
async function writeTargets(
	label: string,
	targets: WriteTarget[],
	progress: vscode.Progress<{ message?: string }>,
	options: { rollback?: boolean } = {}
): Promise<WriteResult> {
	const written: WriteTarget[] = [];
	const failed: string[] = [];
	const context: WriteContext = { editedFiles: new Set<string>(), forceEvaluate: new Set<string>() };
	const useRollback = (options.rollback ?? targets.length > 1) && rollbackEnabled();
	const snapshot = new FileSnapshot();
	if (useRollback) {
		await snapshot.capture(await filesTouchedBy(targets));
	}

	for (const target of targets) {
		progress.report({ message: `${target.packageId} → ${target.version} (${target.projectName})` });
		try {
			const evaluation = await evaluationFor(target.projectPath).catch(() => undefined);
			await applyVersionEdit(planVersionEdit(evaluation, target.projectPath, target.packageId), target, context, evaluation);
			written.push(target);
		} catch (error) {
			failed.push(`${target.packageId} in ${target.projectName}: ${errorText(error)}`);
			logger.error(`${label}: ${target.packageId} in ${target.projectName} failed: ${errorText(error)}`);
			if (useRollback) {
				break;
			}
		}
	}

	forgetEvaluations();
	const rollBack = async (): Promise<WriteResult> => {
		progress.report({ message: vscode.l10n.t("Something failed. Putting the files back...") });
		const { restored, failed: notRestored } = await snapshot.restore();
		forgetEvaluations();
		logger.info(`${label}: rolled back ${restored.length} file(s).${notRestored.length > 0 ? ` Could not put back: ${notRestored.join(", ")}` : ""}`);
		try {
			await restoreForProjects([...new Set(targets.map((target) => target.projectPath))]);
		} catch (error) {
			logger.error(`${label}: restore after the rollback failed: ${errorText(error)}`);
		}
		return { written: [], failed, rolledBack: { restored: restored.length, notRestored } };
	};

	if (failed.length > 0 && useRollback && written.length > 0) {
		return rollBack();
	}

	if (written.length > 0) {
		progress.report({ message: vscode.l10n.t("Restore is running...") });
		const touched = [...new Set(written.map((target) => target.projectPath))];
		try {
			const plain = touched.filter((projectPath) => !context.forceEvaluate.has(pathKey(projectPath)));
			const forced = touched.filter((projectPath) => context.forceEvaluate.has(pathKey(projectPath)));
			await restoreForProjects(plain);
			await restoreForProjects(forced, undefined, true);
		} catch (error) {
			failed.push(errorText(error));
			if (useRollback) {
				return rollBack();
			}
		}
	}
	return { written, failed };
}

function reportWriteResult(label: string, written: number, total: number, failed: string[], rolledBack?: WriteResult["rolledBack"]): void {
	if (failed.length === 0) {
		void vscode.window.showInformationMessage(vscode.l10n.t("{0}: updated {1} of {2}.", label, written, total));
		return;
	}
	logger.show(true);
	if (rolledBack) {
		const tail = rolledBack.notRestored.length > 0
			? `\n\n${vscode.l10n.t("These files could not be put back: {0}", rolledBack.notRestored.join(", "))}`
			: "";
		void vscode.window.showErrorMessage(
			vscode.l10n.t("{0} failed. Every file was put back as it was; nothing was updated.", label),
			{ modal: true, detail: `${failed.join("\n\n")}${tail}` }
		);
		return;
	}
	void vscode.window.showErrorMessage(
		written > 0
			? vscode.l10n.t("{0}: {1} of {2} written, but something failed. Nothing below was updated.", label, written, total)
			: vscode.l10n.t("{0} failed. Nothing was updated.", label),
		{ modal: true, detail: failed.join("\n\n") }
	);
}

let globalPackagesRoot: Promise<string> | undefined;

/** The global packages folder (for example ~/.nuget/packages), read once. */
function packagesRoot(): Promise<string> {
	if (!globalPackagesRoot) {
		globalPackagesRoot = (async () => {
			const root = workspaceScanner.getWorkspaceRoot() || process.cwd();
			try {
				const found = await dotnetCli.localsPath("global-packages", root);
				if (found) {
					return found;
				}
			} catch (error) {
				logger.info(`dotnet nuget locals failed. Using the default packages folder: ${errorText(error)}`);
			}
			return defaultGlobalPackagesPath();
		})();
	}
	return globalPackagesRoot;
}

/**
 * Reads a package's .nuspec from the local cache, or from nuget.org when
 * packageHub.onlineLookups is on and the cache does not have it.
 */
async function loadNuspec(packageId: string, version: string): Promise<{ info?: NuspecInfo; source?: "cache" | "online" }> {
	const cached = await readCachedNuspec(await packagesRoot(), packageId, version);
	if (cached) {
		return { info: cached, source: "cache" };
	}
	if (!onlineLookupsEnabled()) {
		return {};
	}
	const id = encodeURIComponent(packageId.toLowerCase());
	const ver = encodeURIComponent(version.toLowerCase());
	try {
		const info = parseNuspec(await fetchOnlineText(`https://api.nuget.org/v3-flatcontainer/${id}/${ver}/${id}.nuspec`, 15000, "application/xml"));
		return info ? { info, source: "online" } : {};
	} catch (error) {
		logger.info(`Could not read the package metadata of ${packageId} ${version} online: ${errorText(error)}`);
		return {};
	}
}

/** "What's in this update" lines for the confirmation. Never throws. */
async function updateDetailsLines(packageId: string, fromVersions: (string | undefined)[], toVersion: string): Promise<string[]> {
	try {
		const fromVersion = lowestVersion(fromVersions);
		const [to, from] = await Promise.all([
			loadNuspec(packageId, toVersion),
			fromVersion ? loadNuspec(packageId, fromVersion) : Promise.resolve({} as { info?: NuspecInfo }),
		]);
		return describeUpdateDetails({
			packageId,
			toVersion,
			to: to.info,
			source: to.source,
			from: from.info,
			fromVersion,
			online: onlineLookupsEnabled(),
		});
	} catch (error) {
		logger.info(`Could not read what is in ${packageId} ${toVersion}: ${errorText(error)}`);
		return [];
	}
}

/** License changes for a bulk update, read from the local cache only. */
async function licenseChangeLines(targets: { packageId: string; from: string; version: string }[]): Promise<string[]> {
	const root = await packagesRoot();
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const key = `${target.packageId}\n${target.from}\n${target.version}`.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const [from, to] = await Promise.all([
			readCachedNuspec(root, target.packageId, target.from),
			readCachedNuspec(root, target.packageId, target.version),
		]);
		const before = licenseText(from);
		const after = licenseText(to);
		if (before && after && before !== after) {
			lines.push(vscode.l10n.t("License changes for {0}: {1} → {2}", target.packageId, before, after));
		}
	}
	return lines;
}

async function applySafeUpdate(channel: "patch" | "minor"): Promise<void> {
	const projects = await workspaceScanner.findProjects();
	if (projects.length === 0) {
		vscode.window.showErrorMessage(vscode.l10n.t("No .csproj, .fsproj or .vbproj file was found in the workspace."));
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
				progress.report({ message: vscode.l10n.t("Reading {0}: {1}", label, projectName) });

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
		vscode.window.showInformationMessage(vscode.l10n.t("No packages to update for {0}. Major versions and prereleases are not written.", label));
		return;
	}

	const preview = targets
		.slice(0, 15)
		.map((target) => `${target.packageId} ${target.from} → ${target.version} (${target.projectName}, ${versionChange(target.from, target.version)})`);
	const extra = targets.length > 15 ? `\n${vscode.l10n.t("… and {0} more", targets.length - 15)}` : "";
	const licenses = await licenseChangeLines(targets);
	const yes = vscode.l10n.t("Yes, Update");
	const confirm = await vscode.window.showWarningMessage(
		targets.length === 1 ? vscode.l10n.t("{0}: 1 update", label) : vscode.l10n.t("{0}: {1} updates", label, targets.length),
		{
			modal: true,
			detail: [
				`${preview.join("\n")}${extra}`,
				...(licenses.length > 0 ? [licenses.join("\n")] : []),
				vscode.l10n.t("Major versions and prereleases are not written."),
				...(rollbackEnabled() && targets.length > 1 ? [vscode.l10n.t("If one update fails, every file is put back as it was.")] : []),
			].join("\n\n"),
		},
		yes
	);

	if (confirm !== yes) {
		return;
	}

	await writeQueue.run(async () => vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			const { written, failed, rolledBack } = await writeTargets(label, targets, progress);
			logger.info(`${label}: ${written.length} of ${targets.length} written.`);
			reportWriteResult(label, written.length, targets.length, failed, rolledBack);
			if (written.length > 0) {
				await vscode.commands.executeCommand("packageHub.scanWorkspace");
			}
		}
	));
}

// ======================
// Add a package
// ======================

interface PackagePickItem extends vscode.QuickPickItem {
	hit?: SearchHit;
	feedSearch?: boolean;
}

/**
 * Lets the user type a package name. The local NuGet cache answers as they
 * type. The package sources are searched only when they pick
 * "Search package sources", through `dotnet package search`.
 */
async function pickPackageToAdd(initialQuery = ""): Promise<{ hit: SearchHit; searchedFeeds: boolean } | undefined> {
	const root = await packagesRoot();
	const cwd = workspaceScanner.getWorkspaceRoot() || process.cwd();
	const prerelease = ScanState.includePrerelease();
	const picker = vscode.window.createQuickPick<PackagePickItem>();
	picker.title = vscode.l10n.t("PackageHub: Add Package");
	picker.placeholder = vscode.l10n.t("Type a package name. The local NuGet cache is searched first, offline.");
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	let feedHits: SearchHit[] = [];
	let localHits: SearchHit[] = [];
	let searchedFeedsFor = "";
	let generation = 0;

	const render = () => {
		const query = picker.value.trim();
		const merged = mergeHits(localHits, feedHits.filter((hit) => !query || hit.id.toLowerCase().includes(query.toLowerCase().split(/\s+/)[0] ?? "")));
		const items: PackagePickItem[] = merged.map((hit) => ({
			label: `${hit.source === "feed" ? "$(cloud)" : "$(package)"} ${hit.id}`,
			description: newestVersion(hit.versions, prerelease) ?? hit.latestVersion ?? "",
			detail: hit.description ? hit.description.replace(/\s+/g, " ").slice(0, 160) : undefined,
			hit,
			alwaysShow: true,
		}));
		if (query && isValidSearchQuery(query) && searchedFeedsFor !== query.toLowerCase()) {
			items.push({
				label: `$(search) ${vscode.l10n.t("Search package sources for \"{0}\"", query)}`,
				detail: vscode.l10n.t("Runs dotnet package search with the feeds in your NuGet.config."),
				feedSearch: true,
				alwaysShow: true,
			});
		}
		if (query && items.length === 0) {
			items.push({ label: vscode.l10n.t("Use letters, digits, dots and dashes in the package name."), alwaysShow: true });
		}
		picker.items = items;
	};

	const searchLocal = async () => {
		const mine = ++generation;
		const query = picker.value.trim();
		if (!query) {
			localHits = [];
			render();
			return;
		}
		const found = await searchLocalPackages(root, query, 25);
		if (mine === generation) {
			localHits = found;
			render();
		}
	};

	return new Promise((resolve) => {
		let settled = false;
		const done = (value: { hit: SearchHit; searchedFeeds: boolean } | undefined) => {
			if (!settled) {
				settled = true;
				resolve(value);
				picker.dispose();
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		picker.onDidChangeValue(() => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => void searchLocal(), 120);
		});
		picker.onDidAccept(async () => {
			const item = picker.selectedItems[0];
			if (!item) {
				return;
			}
			if (item.hit) {
				done({ hit: item.hit, searchedFeeds: searchedFeedsFor !== "" });
				return;
			}
			if (!item.feedSearch) {
				return;
			}
			const query = picker.value.trim();
			picker.busy = true;
			picker.enabled = false;
			try {
				const result = await dotnetCli.searchPackages(cwd, query, prerelease, 25);
				feedHits = result.hits;
				searchedFeedsFor = query.toLowerCase();
				for (const problem of result.problems) {
					logger.info(`Package search: ${problem}`);
				}
				if (result.hits.length === 0) {
					void vscode.window.showInformationMessage(vscode.l10n.t("No package matched \"{0}\" in the package sources.", query));
				}
			} catch (error) {
				showFailure(vscode.l10n.t("Package search failed"), error);
			} finally {
				picker.busy = false;
				picker.enabled = true;
				render();
			}
		});
		picker.onDidHide(() => done(undefined));
		picker.value = initialQuery;
		picker.show();
		void searchLocal();
	});
}

interface VersionPickItem extends vscode.QuickPickItem {
	version?: string;
	loadMore?: boolean;
}

async function pickVersionToAdd(hit: SearchHit, preferred?: string): Promise<string | undefined> {
	const prerelease = ScanState.includePrerelease();
	const cwd = workspaceScanner.getWorkspaceRoot() || process.cwd();
	let versions = sortVersionsDescending(hit.versions);
	let loaded = hit.source === "feed" && versions.length > 1;
	const local = new Set((await searchLocalPackages(await packagesRoot(), hit.id, 5))
		.find((item) => item.id.toLowerCase() === hit.id.toLowerCase())?.versions ?? []);

	for (; ;) {
		const hasStable = versions.some((version) => !/-/.test(version));
		const showAll = prerelease || !hasStable;
		const newest = newestVersion(versions, showAll);
		const items: VersionPickItem[] = versions
			.filter((version) => showAll || !/-/.test(version) || version === preferred)
			.map((version) => ({
				label: version,
				description: [
					version === newest ? (/-/.test(version) ? vscode.l10n.t("newest") : vscode.l10n.t("newest stable")) : undefined,
					local.has(version.toLowerCase()) || local.has(version) ? vscode.l10n.t("in the local cache") : undefined,
				].filter(Boolean).join(" · "),
				version,
				picked: version === (preferred ?? newest),
			}));
		if (!loaded) {
			items.push({
				label: `$(cloud) ${vscode.l10n.t("Load every version from the package sources")}`,
				detail: vscode.l10n.t("Runs dotnet package search --exact-match."),
				loadMore: true,
			});
		}
		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Version of {0}", hit.id),
			placeHolder: vscode.l10n.t("Pick the version to add"),
		});
		if (!picked) {
			return undefined;
		}
		if (picked.version) {
			return picked.version;
		}
		try {
			const found = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					progress.report({ message: vscode.l10n.t("Reading the versions of {0}...", hit.id) });
					return dotnetCli.packageVersions(cwd, hit.id, prerelease);
				}
			);
			versions = sortVersionsDescending([...versions, ...found]);
		} catch (error) {
			showFailure(vscode.l10n.t("Could not read the versions"), error);
		}
		loaded = true;
	}
}

async function pickProjectsForAdd(packageId: string): Promise<vscode.Uri[] | undefined> {
	const projects = await workspaceScanner.findProjects();
	if (projects.length === 0) {
		vscode.window.showErrorMessage(vscode.l10n.t("No .csproj, .fsproj or .vbproj file was found in the workspace."));
		return undefined;
	}
	const editor = vscode.window.activeTextEditor;
	const active = editor && isMsBuildProject(editor.document.fileName) ? pathKey(editor.document.uri.fsPath) : undefined;
	const referenced = new Map(packageProjects(packageId)
		.filter((item) => item.relation === "direct")
		.map((item) => [item.name.toLowerCase(), item.version]));
	if (projects.length === 1) {
		return projects;
	}
	const picked = await vscode.window.showQuickPick(
		projects
			.map((project) => {
				const name = workspaceScanner.getProjectName(project);
				const has = referenced.get(name.toLowerCase());
				return {
					label: name,
					description: has !== undefined
						? vscode.l10n.t("already references {0} {1}", packageId, has ?? "")
						: vscode.workspace.asRelativePath(project),
					picked: active !== undefined && pathKey(project.fsPath) === active,
					project,
				};
			})
			.sort((left, right) => left.label.localeCompare(right.label)),
		{
			title: vscode.l10n.t("Add {0} to", packageId),
			placeHolder: vscode.l10n.t("Pick one or more projects"),
			canPickMany: true,
		}
	);
	if (!picked || picked.length === 0) {
		return undefined;
	}
	return picked.map((item) => item.project);
}

/**
 * Adds a package to one or more projects with `dotnet add package`. With
 * Central Package Management, dotnet writes PackageVersion to
 * Directory.Packages.props and a version-less PackageReference to the project.
 */
async function addPackage(args?: { packageId?: unknown; version?: unknown; query?: unknown }): Promise<void> {
	let hit: SearchHit | undefined;
	const requestedId = isValidPackageId(args?.packageId) ? args.packageId : undefined;
	const requestedVersion = isValidPackageVersion(args?.version) ? args.version : undefined;
	if (requestedId) {
		const local = (await searchLocalPackages(await packagesRoot(), requestedId, 10))
			.find((item) => item.id.toLowerCase() === requestedId.toLowerCase());
		hit = local ?? { id: requestedId, versions: requestedVersion ? [requestedVersion] : [], source: "feed" };
		if (requestedVersion && !hit.versions.includes(requestedVersion)) {
			hit = { ...hit, versions: sortVersionsDescending([...hit.versions, requestedVersion]) };
		}
	} else {
		const picked = await pickPackageToAdd(typeof args?.query === "string" && isValidSearchQuery(args.query) ? args.query : "");
		hit = picked?.hit;
	}
	if (!hit) {
		return;
	}

	const projects = await pickProjectsForAdd(hit.id);
	if (!projects) {
		return;
	}
	const version = requestedVersion ?? await pickVersionToAdd(hit);
	if (!version) {
		return;
	}
	if (!isValidPackageId(hit.id) || !isValidPackageVersion(version)) {
		vscode.window.showWarningMessage(vscode.l10n.t("That is not a valid package id or version. Nothing was added."));
		return;
	}

	const names = projects.map((project) => workspaceScanner.getProjectName(project));
	const already = packageProjects(hit.id).filter((item) => item.relation === "direct" && names.some((name) => name.toLowerCase() === item.name.toLowerCase()));
	const details = await updateDetailsLines(hit.id, [], version);
	const lines = [
		vscode.l10n.t("Projects: {0}", names.join(", ")),
		ScanState.getCpm()
			? vscode.l10n.t("Central Package Management is on. dotnet writes PackageVersion to Directory.Packages.props and a PackageReference without a version to each project.")
			: vscode.l10n.t("dotnet add package writes a PackageReference to each project."),
		...(already.length > 0 ? [vscode.l10n.t("Already referenced in {0}. The version there changes to {1}.", already.map((item) => `${item.name} ${item.version ?? ""}`.trim()).join(", "), version)] : []),
		...(rollbackEnabled() && projects.length > 1 ? [vscode.l10n.t("If one project fails, every file is put back as it was.")] : []),
		"",
		...details,
	];
	const yes = vscode.l10n.t("Yes, Add");
	const confirm = await vscode.window.showWarningMessage(
		vscode.l10n.t("Add {0} {1}?", hit.id, version),
		{ modal: true, detail: lines.join("\n") },
		yes
	);
	if (confirm !== yes) {
		return;
	}

	const packageId = hit.id;
	await writeQueue.run(async () => vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			const label = vscode.l10n.t("Add {0} {1}", packageId, version);
			const targets: WriteTarget[] = projects.map((project) => ({
				packageId,
				version,
				projectPath: project.fsPath,
				projectName: workspaceScanner.getProjectName(project),
			}));
			const useRollback = rollbackEnabled() && targets.length > 1;
			const snapshot = new FileSnapshot();
			if (useRollback) {
				await snapshot.capture(await filesTouchedBy(targets));
			}
			const failed: string[] = [];
			let added = 0;
			for (const target of targets) {
				progress.report({ message: `${packageId} ${version} → ${target.projectName}` });
				try {
					await dotnetCli.updatePackage(target.projectPath, packageId, version);
					added += 1;
				} catch (error) {
					failed.push(`${target.projectName}: ${errorText(error)}`);
					if (useRollback) {
						break;
					}
				}
			}
			forgetEvaluations();
			let rolledBack: WriteResult["rolledBack"];
			if (failed.length > 0 && useRollback && added > 0) {
				const result = await snapshot.restore();
				rolledBack = { restored: result.restored.length, notRestored: result.failed };
				added = 0;
			}
			if (added > 0 || rolledBack) {
				try {
					await restoreForProjects(targets.map((target) => target.projectPath));
				} catch (error) {
					failed.push(errorText(error));
				}
			}
			logger.info(`${label}: ${added} of ${targets.length} projects.`);
			if (failed.length === 0) {
				void vscode.window.showInformationMessage(targets.length === 1
					? vscode.l10n.t("{0} {1} was added to {2}.", packageId, version, targets[0].projectName)
					: vscode.l10n.t("{0} {1} was added to {2} projects.", packageId, version, added));
			} else {
				reportWriteResult(label, added, targets.length, failed, rolledBack);
			}
			await vscode.commands.executeCommand("packageHub.scanWorkspace");
		}
	));
}

/**
 * Searches for the dashboard's Add package tab. Local cache first; the
 * package sources only when the page asks for them.
 */
export async function searchForDashboard(query: string, online: boolean): Promise<{ hits: SearchHit[]; problems: string[]; error?: string }> {
	const local = await searchLocalPackages(await packagesRoot(), query, 25);
	if (!online) {
		return { hits: local, problems: [] };
	}
	try {
		const cwd = workspaceScanner.getWorkspaceRoot() || process.cwd();
		const feed = await dotnetCli.searchPackages(cwd, query, ScanState.includePrerelease(), 25);
		return { hits: mergeHits(local, feed.hits), problems: feed.problems };
	} catch (error) {
		return { hits: local, problems: [], error: errorText(error) };
	}
}

// ======================
// Align versions
// ======================

function alignLines(plan: AlignPlan): string[] {
	return [
		...plan.moves.map((move) => `${move.projectName}: ${move.from} → ${plan.target}`),
		...(plan.aligned.length > 0 ? [vscode.l10n.t("Already at {0}: {1}.", plan.target, plan.aligned.join(", "))] : []),
	];
}

/**
 * Brings one package to the same version in every project that references
 * it directly, inside each major version.
 */
async function alignVersions(args?: unknown): Promise<void> {
	let packageId = typeof args === "string"
		? args
		: args && typeof args === "object" && typeof (args as { packageId?: unknown }).packageId === "string"
			? (args as { packageId: string }).packageId
			: undefined;
	const entries = ScanState.allEntries();
	if (!packageId) {
		const ids = alignablePackages(entries);
		if (ids.length === 0) {
			vscode.window.showInformationMessage(ScanState.getScannedAt()
				? vscode.l10n.t("No package needs aligning. Every direct reference already uses one version per major version.")
				: vscode.l10n.t("Scan first"));
			return;
		}
		packageId = await vscode.window.showQuickPick(ids, { placeHolder: vscode.l10n.t("Select the package to align") });
		if (!packageId) {
			return;
		}
	}
	if (!isValidPackageId(packageId)) {
		vscode.window.showWarningMessage(vscode.l10n.t("That is not a valid package id."));
		return;
	}

	let plans = planAlignment(packageId, entries);
	if (plans.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("{0} has nothing to align. Different versions per target framework and different major versions are kept.", packageId));
		return;
	}
	if (plans.length > 1) {
		const picked = await vscode.window.showQuickPick(
			plans.map((plan) => ({
				label: vscode.l10n.t("{0}.x → {1}", plan.major, plan.target),
				detail: plan.moves.map((move) => `${move.projectName} ${move.from}`).join(", "),
				picked: true,
				plan,
			})),
			{ canPickMany: true, placeHolder: vscode.l10n.t("{0} is used in more than one major version. Each major version is aligned on its own.", packageId) }
		);
		if (!picked || picked.length === 0) {
			return;
		}
		plans = picked.map((item) => item.plan);
	}

	const kept = plans[0].kept;
	const details: string[] = [];
	for (const plan of plans) {
		details.push(...await updateDetailsLines(packageId, plan.moves.map((move) => move.from), plan.target));
	}
	const lines = [
		...plans.flatMap(alignLines),
		...(kept.length > 0 ? [vscode.l10n.t("Kept: {0}.", kept.map((item) => `${item.projectName} (${item.reason})`).join(", "))] : []),
		vscode.l10n.t("Nothing crosses a major version and nothing is downgraded."),
		...(rollbackEnabled() ? [vscode.l10n.t("If one project fails, every file is put back as it was.")] : []),
		...(details.length > 0 ? ["", ...details] : []),
	];
	const yes = vscode.l10n.t("Yes, Align");
	const confirm = await vscode.window.showWarningMessage(
		vscode.l10n.t("Align {0}?", packageId),
		{ modal: true, detail: lines.join("\n") },
		yes
	);
	if (confirm !== yes) {
		return;
	}

	const id = packageId;
	const targets: WriteTarget[] = plans.flatMap((plan) => plan.moves.map((move) => ({
		packageId: id,
		version: plan.target,
		projectPath: move.projectPath,
		projectName: move.projectName,
	})));
	await writeQueue.run(async () => vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			const label = vscode.l10n.t("Align {0}", id);
			const { written, failed, rolledBack } = await writeTargets(label, targets, progress, { rollback: true });
			reportWriteResult(label, written.length, targets.length, failed, rolledBack);
			if (written.length > 0 || rolledBack) {
				await vscode.commands.executeCommand("packageHub.scanWorkspace");
			}
		}
	));
}

// ======================
// Unused central versions
// ======================

async function removeUnusedCentralVersions(): Promise<void> {
	const propsUris = await workspaceScanner.findCentralPackageManagementFiles();
	if (propsUris.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No Directory.Packages.props was found. Central Package Management is not used here."));
		return;
	}
	const projects = await workspaceScanner.findProjects();
	const evaluated: ProjectEvaluation[] = [];
	const failedProjects: string[] = [];
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
		async (progress) => {
			for (const project of projects) {
				progress.report({ message: vscode.l10n.t("Reading {0}", workspaceScanner.getProjectName(project)) });
				try {
					evaluated.push(await evaluationFor(project.fsPath));
				} catch (error) {
					failedProjects.push(workspaceScanner.getProjectName(project));
					logger.error(`Could not evaluate ${project.fsPath}: ${errorText(error)}`);
				}
			}
		}
	);
	if (failedProjects.length > 0) {
		vscode.window.showWarningMessage(vscode.l10n.t("Could not read {0}. Nothing was removed, because an unread project may use these versions.", failedProjects.join(", ")));
		return;
	}
	const files: { filePath: string; text: string }[] = [];
	for (const uri of propsUris) {
		const text = await readText(uri.fsPath);
		if (text !== undefined) {
			files.push({ filePath: uri.fsPath, text });
		}
	}
	const unused = findUnusedCentralVersions(files, evaluated);
	if (unused.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("Every PackageVersion in Directory.Packages.props is used by a project."));
		return;
	}
	const picked = await vscode.window.showQuickPick(
		unused.map((item) => ({
			label: item.id,
			description: item.version ?? "",
			detail: `${vscode.workspace.asRelativePath(item.filePath)}:${item.line + 1}`,
			picked: true,
			item,
		})),
		{
			canPickMany: true,
			title: vscode.l10n.t("Unused PackageVersion entries"),
			placeHolder: vscode.l10n.t("No project in this workspace references these. Pick the ones to remove."),
		}
	);
	if (!picked || picked.length === 0) {
		return;
	}
	const byFile = new Map<string, string[]>();
	for (const { item } of picked) {
		const list = byFile.get(item.filePath) ?? [];
		list.push(item.id);
		byFile.set(item.filePath, list);
	}
	const yes = vscode.l10n.t("Yes, Remove");
	const confirm = await vscode.window.showWarningMessage(
		picked.length === 1
			? vscode.l10n.t("Remove 1 unused PackageVersion?")
			: vscode.l10n.t("Remove {0} unused PackageVersion entries?", picked.length),
		{
			modal: true,
			detail: [
				picked.map(({ item }) => `${item.id} ${item.version ?? ""}`.trim()).join("\n"),
				vscode.l10n.t("Edits {0}.", [...byFile.keys()].map((file) => vscode.workspace.asRelativePath(file)).join(", ")),
				vscode.l10n.t("Only projects in this workspace were checked. A project outside it that imports the same file may still need them."),
			].join("\n\n"),
		},
		yes
	);
	if (confirm !== yes) {
		return;
	}
	await writeQueue.run(async () => {
		const failed: string[] = [];
		for (const [filePath, ids] of byFile) {
			try {
				await rewriteFile(filePath, (text) => removePackageVersionsFromXml(text, ids), vscode.l10n.t("{0} could not be written.", path.basename(filePath)));
			} catch (error) {
				failed.push(`${path.basename(filePath)}: ${errorText(error)}`);
			}
		}
		forgetEvaluations();
		if (failed.length > 0) {
			showFailure(vscode.l10n.t("Could not remove the unused versions"), failed.join("\n"));
			return;
		}
		void vscode.window.showInformationMessage(picked.length === 1
			? vscode.l10n.t("Removed 1 unused PackageVersion.")
			: vscode.l10n.t("Removed {0} unused PackageVersion entries.", picked.length));
		try {
			await restoreForProjects(projects.map((project) => project.fsPath));
		} catch (error) {
			logger.error(`Restore after removing unused versions failed: ${errorText(error)}`);
		}
	});
	await vscode.commands.executeCommand("packageHub.scanWorkspace");
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
			{ scheme: "file", pattern: PACKAGE_DOCUMENT_GLOB },
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

		if (event.affectsConfiguration("packageHub.badge")) {
			treeProvider.refresh();
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
			{ scheme: "file", pattern: PACKAGE_DOCUMENT_GLOB }
		],
		new PackageHoverProvider(codeActionProvider, workspaceScanner)
	);
	context.subscriptions.push(hoverProvider);
	context.subscriptions.push(
		auditDiagnostics,
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file", pattern: PACKAGE_DOCUMENT_GLOB },
			codeActionProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	// A new or deleted project file changes what the Package Health view shows.
	const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj,sln,slnx}", false, true, false);
	// Clear the project cache first so the view does not read a stale list.
	const projectsChanged = () => {
		workspaceScanner.invalidate();
		treeProvider.refresh();
	};
	projectWatcher.onDidCreate(projectsChanged);
	projectWatcher.onDidDelete(projectsChanged);
	// Editing a solution changes which projects it holds.
	const solutionWatcher = vscode.workspace.createFileSystemWatcher("**/*.{sln,slnx}", true, false, true);
	solutionWatcher.onDidChange(projectsChanged);
	context.subscriptions.push(solutionWatcher);
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
			vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
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
				vscode.l10n.t("The patch list is not ready yet. The update was not started.")
			);
			return;
		}

		const version = channel === "patch" ? peek.patch : peek.latest;
		if (!version) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("No {0} version for {1}. The update was not started.", channel, ref.id)
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
					vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
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
						vscode.l10n.t("No package to ignore. Run Scan Workspace first.")
					);
					return;
				}

				const picked = await vscode.window.showQuickPick(uniqueIds, {
					placeHolder: vscode.l10n.t("Select the package to ignore"),
				});

				if (!picked) {
					return;
				}

				packageId = picked;
			}

			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage(vscode.l10n.t("That is not a valid package id."));
				return;
			}

			const url = advisorySuppressUrl(packageId);
			const choice = await vscode.window.showQuickPick(
				[
					{
						label: vscode.l10n.t("Hide in PackageHub"),
						description: vscode.l10n.t("List"),
						detail: vscode.l10n.t("The build warning stays"),
						suppress: false,
					},
					{
						label: vscode.l10n.t("Suppress this advisory"),
						description: url ? "NuGetAuditSuppress" : vscode.l10n.t("Off"),
						detail: url || vscode.l10n.t("No advisory URL"),
						suppress: true,
					},
				],
				{ placeHolder: vscode.l10n.t("Ignore for {0}", packageId) }
			);
			if (!choice) {
				return;
			}
			if (choice.suppress) {
				if (!url) {
					vscode.window.showWarningMessage(vscode.l10n.t("No advisory URL. Suppress is unavailable."));
					return;
				}
				await openSuppressDiff(packageId, url);
				return;
			}

			const config = vscode.workspace.getConfiguration("packageHub");
			const current = config.get<string[]>("ignoredPackages", []);
			const id = packageId;

			if (current.some((item) => item.toLowerCase() === id.toLowerCase())) {
				vscode.window.showInformationMessage(vscode.l10n.t("{0} is already in the ignore list.", id));
				return;
			}

			await config.update("ignoredPackages", [...current, id], vscode.ConfigurationTarget.Workspace);

			vscode.window.showInformationMessage(
				vscode.l10n.t("{0} is hidden from PackageHub lists. The build warning stays.", id)
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
				vscode.window.showInformationMessage(vscode.l10n.t("The ignore list is empty."));
				return;
			}

			const picked = await vscode.window.showQuickPick(current, {
				placeHolder: vscode.l10n.t("Select the package to unignore"),
			});

			if (!picked) {
				return;
			}

			await config.update(
				"ignoredPackages",
				current.filter((id) => id.toLowerCase() !== picked.toLowerCase()),
				vscode.ConfigurationTarget.Workspace
			);

			vscode.window.showInformationMessage(vscode.l10n.t("{0} was removed from the ignore list.", picked));
			await vscode.commands.executeCommand("packageHub.scanWorkspace");
		}
	);

	const explainCommand = vscode.commands.registerCommand(
		"packageHub.explainSelectedPackage",
		async () => {
			try {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showWarningMessage(vscode.l10n.t("No editor is open."));
					return;
				}

				const ref = activeLineRef();
				if (!ref) {
					vscode.window.showWarningMessage(
						vscode.l10n.t("No PackageReference was found on this line.")
					);
					return;
				}

				const packageId = ref.id;
				const { vulnerable, outdated, deprecated } = ScanState.findPackage(packageId);
				const info = vulnerable || outdated || deprecated;

				if (!info) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("{0} has no known issue in the last scan (or no scan has run yet).", packageId)
					);
					return;
				}

				const lines = [
					`${packageId}`,
					info.version ? vscode.l10n.t("Current: {0}", info.version) : undefined,
					info.latestVersion ? vscode.l10n.t("Suggested: {0}", info.latestVersion) : undefined,
					info.severity ? vscode.l10n.t("Severity: {0}", info.severity) : undefined,
					vulnerable ? vscode.l10n.t("Status: Vulnerable") : undefined,
					!vulnerable && deprecated ? vscode.l10n.t("Status: Deprecated") : undefined,
					!vulnerable && !deprecated && outdated ? vscode.l10n.t("Status: Outdated") : undefined,
					info.projects?.length ? vscode.l10n.t("Projects: {0}", info.projects.join(", ")) : undefined,
				].filter(Boolean);

				const openAdvisory = vscode.l10n.t("Open Advisory");
				const updateButton = vscode.l10n.t("Update");
				const buttons: string[] = [];
				const advisory = info.advisoryUrl?.startsWith("https://") ? info.advisoryUrl : undefined;
				if (advisory) {
					buttons.push(openAdvisory);
				}
				if (info.latestVersion) {
					buttons.push(updateButton);
				}

				const action = await vscode.window.showInformationMessage(
					lines.join(" | "),
					...buttons
				);

				if (action === openAdvisory && advisory) {
					await vscode.env.openExternal(vscode.Uri.parse(advisory));
				}

				if (action === updateButton) {
					await vscode.commands.executeCommand("packageHub.updateVulnerable", {
						packageId: info.id,
						version: info.latestVersion,
					});
				}
			} catch (error: any) {
				logger.error(`Could not explain the package: ${error?.message || error}`);
				vscode.window.showErrorMessage(vscode.l10n.t("Could not explain the package."));
			}
		}
	);

	const performWorkspaceScan = async () => {
		const workspaceRoot = workspaceScanner.getWorkspaceRoot();

		if (!workspaceRoot) {
			vscode.window.showErrorMessage(
				vscode.l10n.t("No workspace is open. Open a folder.")
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
				progress.report({ message: vscode.l10n.t("Scanning packages...") });

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

					// .sln and .slnx are both scanned as one target. When dotnet cannot read a
					// solution (for example a .slnx on an older SDK), its projects are scanned one by one.
					const foundSolutions = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
					const solutionMembership = await readSolutionProjects(foundSolutions);
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
							vscode.l10n.t("No .sln, .slnx, .csproj, .fsproj or .vbproj file was found in the workspace.")
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
						const extra = skipped.length > 3 ? ` ${vscode.l10n.t("and {0} more", skipped.length - 3)}` : "";
						vscode.window.showWarningMessage(
							skipped.length === 1
								? vscode.l10n.t("PackageHub skipped 1 project that dotnet could not load: {0}. The other projects were scanned.", `${names.join(", ")}${extra}`)
								: vscode.l10n.t("PackageHub skipped {0} projects that dotnet could not load: {1}. The other projects were scanned.", skipped.length, `${names.join(", ")}${extra}`)
						);
					}
					if (unreadable.length > 0) {
						const names = unreadable.slice(0, 3).map((item) => projectNameFromPath(item));
						vscode.window.showWarningMessage(
							vscode.l10n.t("dotnet could not read {0}. Those projects are not marked healthy. Run Restore All and see the Output panel.", `${names.join(", ")}${unreadable.length > 3 ? ` ${vscode.l10n.t("and {0} more", unreadable.length - 3)}` : ""}`)
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
					vscode.window.showInformationMessage(vscode.l10n.t("Scan finished → Vulnerable: {0}, Outdated: {1}, Deprecated: {2}", vulnerable.length, outdated.length, deprecated.length));
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
						vscode.l10n.t("PackageHub scan error: {0}", errorMessage)
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
				// The running scan goes once more when it finishes. Wait for
				// that, so a caller that awaits the command sees fresh data.
				logger.info("A scan is already running. It will run once more when it finishes.");
				await runningScan?.catch(() => undefined);
				return;
			}
			const scan = (async () => {
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
			})();
			runningScan = scan;
			try {
				await scan;
			} finally {
				if (runningScan === scan) {
					runningScan = undefined;
				}
			}
		}
	);

	const updateCommand = vscode.commands.registerCommand(
		"packageHub.updateVulnerable",
		async (args?: { packageId?: unknown; version?: unknown; projectName?: unknown; projects?: unknown }) => {
			const packageId = args?.packageId;
			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage(vscode.l10n.t("The package update details are missing or invalid."));
				return;
			}
			const version = typeof args?.version === "string" && args.version ? args.version : undefined;
			if (version !== undefined && !isValidPackageVersion(version)) {
				vscode.window.showWarningMessage(vscode.l10n.t("\"{0}\" is not an exact NuGet version. The update was not started.", version));
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
					vscode.l10n.t("{0} is already at {1} or newer in {2}. Nothing was updated.", packageId, version ?? "", newerProjects.map((item) => item.name).join(", "))
				);
				return;
			}

			if (targets.length === 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("No project was matched for {0}. Nothing was updated, and no restore was run.", packageId)
				);
				logger.error(`Update cancelled: no matching project → ${packageId}`);
				return;
			}

			if (!version) {
				const tryAnyway = vscode.l10n.t("Try anyway");
				const cont = await vscode.window.showWarningMessage(
					vscode.l10n.t("No newer version was suggested for {0}.", packageId),
					{
						modal: true,
						detail: vscode.l10n.t("A newer version may not exist under the same package id (for example xunit → xunit.v3).\nRun \"dotnet add package {0}\" anyway?", packageId),
					},
					tryAnyway
				);

				if (cont !== tryAnyway) {
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
				summary.lines.push(vscode.l10n.t("Left as is, already newer than {0}: {1}.", version ?? "", newerProjects.map((item) => `${item.name} ${item.from}`).join(", ")));
			}
			if (version) {
				const details = await updateDetailsLines(packageId, summaryProjects.map((item) => item.fromVersion), version);
				if (details.length > 0) {
					summary.lines.push("", ...details);
				}
			}

			const yesUpdate = vscode.l10n.t("Yes, Update");
			const confirm = await vscode.window.showWarningMessage(
				summary.heading,
				{ modal: true, detail: summary.lines.join("\n") },
				yesUpdate
			);
			if (confirm !== yesUpdate) {
				return;
			}

			const transitive = targets.filter((target) => target.relation === "transitive");
			if (transitive.length > 0) {
				const yesPin = vscode.l10n.t("Yes, Pin");
				const projectsText = transitive.map((target) => target.name).join(", ");
				const pin = await vscode.window.showWarningMessage(
					vscode.l10n.t("Pin transitive {0}?", packageId),
					{
						modal: true,
						detail: [
							vscode.l10n.t("{0} is not referenced directly in {1}.", packageId, projectsText),
							version
								? vscode.l10n.t("PackageHub will add a direct PackageReference at {0} there.", version)
								: vscode.l10n.t("PackageHub will add a direct PackageReference there."),
							vscode.l10n.t("That pin stays after the parent package changes, until you remove it."),
						].join(" "),
					},
					yesPin
				);
				if (pin !== yesPin) {
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
							progress.report({ message: vscode.l10n.t("{0} → latest ({1})", packageId, target.projectName) });
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

					const { written, failed, rolledBack } = await writeTargets(`${packageId} → ${version}`, writeTargetsList, progress);
					logger.info(`${packageId} → ${version}: ${written.length} of ${writeTargetsList.length} written.`);
					reportWriteResult(`${packageId} → ${version}`, written.length, writeTargetsList.length, failed, rolledBack);
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
				vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
				return;
			}
			if (!isValidPackageId(packageId)) {
				vscode.window.showWarningMessage(vscode.l10n.t("That is not a valid package id. Removal was not started."));
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
					vscode.l10n.t("Could not match a project for {0}. Removal was not started.", packageId)
				);
				return;
			}

			const projectNames = targets
				.map((project) => workspaceScanner.getProjectName(project))
				.join("\n");
			const yesRemove = vscode.l10n.t("Yes, Remove");
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t("Remove {0}?", packageId),
				{ modal: true, detail: projectNames },
				yesRemove
			);
			if (confirm !== yesRemove) {
				return;
			}

			await writeQueue.run(async () => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					let removed = 0;
					const failed: string[] = [];
					for (const project of targets) {
						progress.report({
							message: vscode.l10n.t("{0} removing → {1}", packageId, workspaceScanner.getProjectName(project)),
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
						vscode.window.showInformationMessage(vscode.l10n.t("{0} was removed.", packageId));
					} else {
						logger.show(true);
						vscode.window.showErrorMessage(
							vscode.l10n.t("Remove failed for {0} of {1} projects.", failed.length, targets.length),
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
				vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
				return;
			}

			const url = advisorySuppressUrl(ref.id);
			if (!url) {
				vscode.window.showWarningMessage(vscode.l10n.t("No advisory link for this package."));
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const updateSelectedCommand = vscode.commands.registerCommand(
		"packageHub.updateSelectedPackage",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage(vscode.l10n.t("Could not select a package"));
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
				vscode.window.showWarningMessage(vscode.l10n.t("Could not select a package."));
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
				vscode.window.showWarningMessage(vscode.l10n.t("Could not select a package."));
				return;
			}

			const { vulnerable, outdated, deprecated } = ScanState.findPackage(item.packageId);
			const info = vulnerable || outdated || deprecated || ScanState.findInstalled(item.packageId);
			const version = info?.version || (typeof item.version === "string" ? item.version : undefined);

			const lines = [
				vscode.l10n.t("Package: {0}", item.packageId),
				version ? vscode.l10n.t("Current: {0}", version) : undefined,
				info?.latestVersion ? vscode.l10n.t("Latest version: {0}", info.latestVersion) : undefined,
				info?.severity ? vscode.l10n.t("Severity: {0}", info.severity) : undefined,
				info?.projects?.length ? vscode.l10n.t("Projects: {0}", info.projects.join(", ")) : undefined,
			].filter(Boolean);

			vscode.window.showInformationMessage(lines.join(" | "));
		}
	);

	const openNugetCommand = vscode.commands.registerCommand(
		"packageHub.openNugetPage",
		async (item?: any) => {
			if (!isValidPackageId(item?.packageId)) {
				vscode.window.showWarningMessage(vscode.l10n.t("Could not select a package."));
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
				vscode.window.showErrorMessage(vscode.l10n.t("No workspace is open."));
				return;
			}

			const projects = await workspaceScanner.findProjects();
			if (projects.length === 0) {
				vscode.window.showErrorMessage(vscode.l10n.t("No .csproj, .fsproj or .vbproj was found to restore."));
				return;
			}

			await writeQueue.run(async () => vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "PackageHub", cancellable: false },
				async (progress) => {
					progress.report({ message: vscode.l10n.t("Restore is running...") });

					try {
						await restoreForProjects(projects.map((project) => project.fsPath));
						vscode.window.showInformationMessage(vscode.l10n.t("Restore finished."));
					} catch (error) {
						showFailure(vscode.l10n.t("Restore failed"), error);
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
				vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
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
				vscode.window.showWarningMessage(vscode.l10n.t("No package was found on this line."));
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
						vscode.l10n.t("No project was found for {0}: {1}", packageId, requestedProject)
					);
					return;
				}
				projectPath = match.fsPath;
			} else if (editor && isMsBuildProject(editor.document.uri.fsPath)) {
				projectPath = editor.document.uri.fsPath;
			} else if (projects.length === 1) {
				projectPath = projects[0].fsPath;
			} else if (projects.length === 0) {
				vscode.window.showErrorMessage(vscode.l10n.t("No .csproj, .fsproj or .vbproj file was found in the workspace."));
				return;
			} else {
				const picked = await vscode.window.showQuickPick(
					projects.map((project) => ({
						label: workspaceScanner.getProjectName(project),
						description: project.fsPath,
						fsPath: project.fsPath,
					})),
					{ placeHolder: vscode.l10n.t("Select a project for Why") }
				);
				if (!picked) {
					return;
				}
				projectPath = picked.fsPath;
			}

			if (!projectPath) {
				vscode.window.showErrorMessage(vscode.l10n.t("No .csproj, .fsproj or .vbproj file was found in the workspace."));
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
					progress.report({ message: vscode.l10n.t("Finding why {0} is here…", packageId) });

					try {
						const text = await dotnetCli.why(selectedProject, packageId);
						logger.show(true);
						logger.info(`Why: ${packageId} (${selectedProject})`);
						logger.appendLine(text);
						await DependencyGraphPanel.show(packageId);
						vscode.window.showInformationMessage(
							vscode.l10n.t("Opened the path for {0}. The CLI text is in the Output panel.", packageId)
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
				vscode.window.showInformationMessage(vscode.l10n.t("Scan first"));
				return;
			}

			try {
				await vscode.env.clipboard.writeText(markdown);
			} catch (error: any) {
				logger.error(`Could not copy the health report: ${error?.message || error}`);
				vscode.window.showErrorMessage(vscode.l10n.t("Could not copy the health report."));
				return;
			}
			vscode.window.showInformationMessage(vscode.l10n.t("Health report copied to the clipboard."));
		}
	);

	const copyVulnerabilityReportCommand = vscode.commands.registerCommand(
		"packageHub.copyVulnerabilityReport",
		async () => {
			const markdown = buildVulnerabilityReport();
			if (markdown === undefined) {
				vscode.window.showInformationMessage(vscode.l10n.t("Scan first"));
				return;
			}
			if (markdown === "") {
				vscode.window.showInformationMessage(vscode.l10n.t("No vulnerabilities."));
				return;
			}

			try {
				await vscode.env.clipboard.writeText(markdown);
			} catch (error: any) {
				logger.error(`Could not copy the vulnerability report: ${error?.message || error}`);
				vscode.window.showErrorMessage(vscode.l10n.t("Could not copy the vulnerability report."));
				return;
			}
			vscode.window.showInformationMessage(vscode.l10n.t("Vulnerability report copied to the clipboard."));
		}
	);

	const openAdvisoryCommand = vscode.commands.registerCommand(
		"packageHub.openAdvisory",
		async (url?: unknown) => {
			if (typeof url !== "string" || !url.startsWith("https://")) {
				vscode.window.showWarningMessage(vscode.l10n.t("No advisory link."));
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const quickFixBlockedCommand = vscode.commands.registerCommand(
		"packageHub.quickFixBlocked",
		async (message?: unknown) => {
			vscode.window.showWarningMessage(
				typeof message === "string" && message ? message.slice(0, 300) : vscode.l10n.t("No patch version. The update was not started.")
			);
		}
	);

	HealthDashboardPanel.searchHandler = async (query, online) => {
		const result = await searchForDashboard(query, online);
		return {
			hits: result.hits.slice(0, 25).map((hit) => ({
				id: hit.id,
				version: hit.latestVersion ?? hit.versions[0] ?? "",
				description: hit.description,
				source: hit.source === "local" ? "local" : hit.sourceName ?? "feed",
			})).filter((hit) => hit.version),
			problems: result.problems,
			error: result.error,
		};
	};
	const addPackageCommand = vscode.commands.registerCommand("packageHub.addPackage", (args?: { packageId?: unknown; version?: unknown; query?: unknown }) => addPackage(args));
	const alignVersionsCommand = vscode.commands.registerCommand("packageHub.alignVersions", (args?: unknown) => alignVersions(args));
	const removeUnusedVersionsCommand = vscode.commands.registerCommand("packageHub.removeUnusedCentralVersions", () => removeUnusedCentralVersions());

	const codeLensPendingCommand = vscode.commands.registerCommand(
		"packageHub.codeLensPending",
		async () => {
			vscode.window.showInformationMessage(
				vscode.l10n.t("The lens above the line shows the version once the patch list is ready. Latest is not on this line.")
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
		addPackageCommand,
		alignVersionsCommand,
		removeUnusedVersionsCommand,
		logger
	);

	// A changed project or props file makes the MSBuild evaluation stale.
	const evaluationWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj,props,targets}");
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
						vscode.l10n.t("Restore after save failed. The scan shows what dotnet could still read. See the Output panel.")
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
