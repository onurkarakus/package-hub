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
		{ placeHolder: "Suppress hangi projeye yazılsın" }
	);
	return picked?.uri;
}

async function openSuppressDiff(packageId: string, url: string): Promise<void> {
	const uri = await suppressTarget(packageId);
	if (!uri) {
		vscode.window.showWarningMessage("Bu paketin csproj dosyası bulunamadı. Suppress yazılmadı.");
		return;
	}

	const document = await vscode.workspace.openTextDocument(uri);
	const text = document.getText();
	if (alreadySuppressed(text, url)) {
		vscode.window.showInformationMessage("Bu advisory zaten NuGetAuditSuppress içinde.");
		return;
	}

	const closing = text.lastIndexOf("</Project>");
	if (closing < 0) {
		vscode.window.showErrorMessage("csproj kapanışı yok. Suppress yazılmadı.");
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
		vscode.window.showErrorMessage("Suppress taslağı açılamadı. Dosya değişmedi.");
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
		logger.info(`Diff komutu açılmadı: ${error?.message || error}`);
	}
	vscode.window.showInformationMessage(
		"Suppress taslağı diff’te açıldı. Kaydet, sonra Restore All çalıştır. Kaydetmezsen dosya değişmez."
	);
}

interface TargetScan {
	vulnerable: any[];
	outdated: any[];
	deprecated: any[];
	patch: any[];
}

async function scanOneTarget(
	cli: DotnetCli,
	targetPath: string,
	label: string,
	signal: AbortSignal
): Promise<TargetScan> {
	logger.info(`[${label}] vulnerable başladı`);
	logger.info(`[${label}] outdated başladı`);
	logger.info(`[${label}] deprecated başladı`);

	const track = (name: string, work: Promise<any[]>) =>
		work.then((value) => {
			logger.info(`[${label}] ${name} bitti`);
			return value;
		});

	const settled = await Promise.allSettled([
		track("vulnerable", cli.listVulnerable(targetPath, true, signal)),
		track("outdated", cli.listOutdated(targetPath, false, "latest", signal, ScanState.includePrerelease())),
		track("deprecated", cli.listDeprecated(targetPath, signal)),
		track("patch", cli.listOutdated(targetPath, false, "patch", signal, ScanState.includePrerelease())),
	]);

	if (settled.some((result) =>
		result.status === "rejected"
		&& String(result.reason?.message || result.reason).includes("`dotnet` komutu bulunamadı")
	)) {
		throw new Error("`dotnet` komutu bulunamadı. .NET SDK yüklü mü?");
	}

	const names = ["vulnerable", "outdated", "deprecated", "patch"] as const;
	const lists = names.map((name, index) => {
		const result = settled[index];
		if (result.status === "fulfilled") {
			return result.value;
		}

		if (!signal.aborted) {
			logger.error(`[${label}] ${name} alınamadı: ${result.reason?.message || result.reason}`);
		}
		return [];
	});

	return {
		vulnerable: lists[0],
		outdated: lists[1],
		deprecated: lists[2],
		patch: lists[3],
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
	for (const skipped of slnxPaths(found)) {
		logger.info(`.slnx atlandı: ${skipped}`);
	}

	const solutions = classicSolutionPaths(found);
	if (projectPaths.length === 0) {
		for (const solutionPath of solutions) {
			logger.info(`Restore: ${solutionPath}`);
			await dotnetCli.restore(solutionPath);
		}
		return;
	}

	const membership = await readSolutionProjects(solutions);
	for (const solution of membership) {
		if (solution.error) {
			logger.error(`Solution okunamadı (${solution.solutionPath}): ${solution.error}`);
		}
	}

	for (const target of restoreTargetsForProjects(membership, projectPaths)) {
		logger.info(`Restore: ${target}`);
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
		vscode.window.showErrorMessage("Workspace içinde hiç .csproj dosyası bulunamadı.");
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
				progress.report({ message: `${label} okunuyor… ${projectName}` });

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
					logger.error(`${label} listesi alınamadı (${project.fsPath}): ${message}`);
					if (message.includes("`dotnet` komutu bulunamadı")) {
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
		vscode.window.showInformationMessage(`${label} için güncellenecek paket yok. Major sürüm yazılmaz.`);
		return;
	}

	const preview = targets
		.slice(0, 15)
		.map((target) => `${target.packageId} ${target.from} → ${target.to} (${target.projectName})`);
	const extra = targets.length > 15 ? `\n… ve ${targets.length - 15} hedef daha` : "";
	const confirm = await vscode.window.showWarningMessage(
		`${label}\n\n${preview.join("\n")}${extra}\n\nMajor sürüm yazılmaz.`,
		{ modal: true },
		"Evet, Güncelle"
	);

	if (confirm !== "Evet, Güncelle") {
		logger.info(`${label} iptal edildi.`);
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
					logger.info(`Güncellendi: ${target.packageId} → ${target.to} (${target.projectPath})`);
				}

				progress.report({ message: "Restore çalışıyor..." });
				const updatedProjects = [...new Set(targets.map((target) => target.projectPath))];
				await restoreForProjects(updatedProjects);

				vscode.window.showInformationMessage(`${label}: ${targets.length} hedef güncellendi.`);
				await vscode.commands.executeCommand("packageHub.scanWorkspace");
			} catch (error: any) {
				const message = error.message || String(error);
				logger.show(true);
				logger.error(`${label} hatası: ${message}`);
				vscode.window.showErrorMessage(`Güncelleme başarısız: ${message}`);
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
	logger.info("PackageHub aktif edildi.");

	// Servisler
	dotnetCli = new DotnetCli();
	workspaceScanner = new WorkspaceScanner();
	const cacheService = new CacheService();

	// Status Bar
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	statusBarItem.tooltip = "PackageHub – Tıklayarak Health Dashboard’u aç";
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
	context.subscriptions.push(
		codeLensProvider,
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file", pattern: "**/*.{csproj,props}" },
			codeLensProvider
		)
	);
	if (ScanState.getScannedAt()) {
		void auditDiagnostics.refresh().finally(() => {
			codeLensProvider.refresh();
		});
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("packageHub.minimumSeverity")) {
			const minimum = vscode.workspace.getConfiguration("packageHub").get<string>("minimumSeverity") || "low";
			logger.info(`Severity eşiği: ${minimum}`);
			paintScanStatus(statusBarItem);
			treeProvider.refresh();
			HealthDashboardPanel.refreshIfOpen();
			codeLensProvider.refresh();
			void auditDiagnostics.refresh();
		}

		if (event.affectsConfiguration("packageHub.minimumReleaseAge")) {
			const days = vscode.workspace.getConfiguration("packageHub").get<number>("minimumReleaseAge");
			logger.info(typeof days === "number" && days > 0
				? `Yaş kapısı: ${days} gün`
				: "Yaş kapısı kapalı.");
		}

		if (event.affectsConfiguration("packageHub.includePrerelease")) {
			logger.info(ScanState.includePrerelease()
				? "Ön sürüm açık. Sonraki taramada uygulanır."
				: "Ön sürüm kapalı. Sonraki taramada uygulanır.");
			codeActionProvider.clearCache();
		}
	}));

	void refreshCentralPackages(workspaceScanner)
		.then(() => {
			treeProvider.refresh();
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`CPM okunamadı: ${error.message}`);
		});

	void refreshNuGetSources(workspaceScanner)
		.then(() => {
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`NuGet.config okunamadı: ${error.message}`);
		});

	void workspaceScanner.findProjects()
		.then(async (projects) => {
			const gap = await workspaceHasAuditDataGap(projects.map((project) => project.fsPath));
			ScanState.setAuditDataGap(gap);
			paintScanStatus(statusBarItem);
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`Audit kaynağı uyarısı okunamadı: ${error.message}`);
		});

	// Hover açıklamasıdır. Güncelleme linkleri ampulün önbelleğini okur, yeni dotnet çağrısı başlatmaz.
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ language: "xml", scheme: "file", pattern: "**/*.{csproj,props}" }
		],
		new PackageHoverProvider(codeActionProvider, workspaceScanner)
	);
	context.subscriptions.push(hoverProvider);
	context.subscriptions.push(
		auditDiagnostics,
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file", pattern: "**/*.{csproj,props}" },
			codeActionProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

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

		const projectName = editor.document.fileName.toLowerCase().endsWith(".csproj")
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
			vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
			return;
		}

		const peek = await codeActionProvider.peekUpdateTargets(
			ref.document,
			ref.id,
			lineCurrentVersion(ref)
		);
		if (!peek.ready) {
			vscode.window.showInformationMessage(
				"Patch listesi henüz hazır değil. Güncelleme başlatılmadı."
			);
			return;
		}

		const version = channel === "patch" ? peek.patch : peek.latest;
		if (!version) {
			vscode.window.showWarningMessage(
				`${ref.id} için ${channel} sürümü yok. Güncelleme başlatılmadı.`
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
					vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
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
						"Ignore için paket yok. Önce Scan Workspace çalıştır."
					);
					return;
				}

				const picked = await vscode.window.showQuickPick(uniqueIds, {
					placeHolder: "Ignore edilecek paketi seç",
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
						description: "Liste",
						detail: "Build uyarısı durur",
					},
					{
						label: "Suppress this advisory",
						description: url ? "NuGetAuditSuppress" : "Kapalı",
						detail: url || "Advisory URL yok",
					},
				],
				{ placeHolder: `${packageId} için ignore` }
			);
			if (!choice) {
				return;
			}
			if (choice.label === "Suppress this advisory") {
				if (!url) {
					vscode.window.showWarningMessage("Advisory URL yok. Suppress kapalı.");
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
				`${packageId} PackageHub listesinden gizlendi. Build uyarısı durur.`
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
				vscode.window.showInformationMessage("Ignore listesi boş.");
				return;
			}

			const picked = await vscode.window.showQuickPick(current, {
				placeHolder: "Ignore listesinden çıkarılacak paket",
			});

			if (!picked) {
				return;
			}

			await config.update(
				"ignoredPackages",
				current.filter((id) => id.toLowerCase() !== picked.toLowerCase()),
				vscode.ConfigurationTarget.Workspace
			);

			vscode.window.showInformationMessage(`${picked} ignore listesinden çıktı.`);
			await vscode.commands.executeCommand("packageHub.scanWorkspace");
		}
	);

	const explainCommand = vscode.commands.registerCommand(
		"packageHub.explainSelectedPackage",
		async () => {
			try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage("Açık bir editör yok.");
				return;
			}

			const line = editor.document.lineAt(editor.selection.active.line).text;
			const match = line.match(/PackageReference\s+Include="([^"]+)"/i);

			if (!match) {
				vscode.window.showWarningMessage(
					"Bu satırda PackageReference bulunamadı."
				);
				return;
			}

			const packageId = match[1];
			const { vulnerable, outdated, deprecated } = ScanState.findPackage(packageId);
			const info = vulnerable || outdated || deprecated;

			if (!info) {
				vscode.window.showInformationMessage(
					`${packageId} sağlıklı görünüyor (veya henüz scan yapılmadı).`
				);
				return;
			}

			const lines = [
				`${packageId}`,
				info.version ? `Mevcut: ${info.version}` : undefined,
				info.latestVersion ? `Önerilen: ${info.latestVersion}` : undefined,
				info.severity ? `Severity: ${info.severity}` : undefined,
				vulnerable ? "Durum: Vulnerable" : undefined,
				!vulnerable && deprecated ? "Durum: Deprecated" : undefined,
				!vulnerable && !deprecated && outdated ? "Durum: Outdated" : undefined,
				info.projects?.length ? `Projeler: ${info.projects.join(", ")}` : undefined,
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
				logger.error(`Paket açıklanamadı: ${error?.message || error}`);
				vscode.window.showErrorMessage("Paket açıklanamadı.");
			}
		}
	);

	const performWorkspaceScan = async () => {
			const workspaceRoot = workspaceScanner.getWorkspaceRoot();

			if (!workspaceRoot) {
				vscode.window.showErrorMessage(
					"Açık bir workspace bulunamadı. Lütfen bir klasör açın."
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
					progress.report({ message: "Paketler taranıyor..." });

					const abort = new AbortController();
					const cancelSub = token.onCancellationRequested(() => abort.abort());

					try {
						logger.show(true);
						logger.info(`Tarama başlatıldı: ${workspaceRoot}`);

						// Her taramada cache’i temizle (şimdilik stabilite için)
						cacheService.invalidateAll();

						let vulnerable: any[] = [];
						let outdated: any[] = [];
						let deprecated: any[] = [];
						let patch: any[] = [];

						const foundSolutions = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
						for (const skipped of slnxPaths(foundSolutions)) {
							logger.info(`.slnx atlandı: ${skipped}`);
						}
						const solutions = classicSolutionPaths(foundSolutions);

						if (token.isCancellationRequested) {
							logger.info("Tarama iptal edildi. Sonuç çizilmedi.");
							return;
						}

						if (solutions.length > 0) {
							logger.info(`${solutions.length} solution taranacak.`);
							const allVulnerable: any[] = [];
							const allOutdated: any[] = [];
							const allDeprecated: any[] = [];
							const allPatch: any[] = [];

							await runPool(solutions.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
								const targetPath = solutions[index];
								const label = path.basename(targetPath);
								progress.report({ message: `${index + 1}/${solutions.length} ${label}` });
								logger.info(`Solution taranıyor: ${targetPath}`);

								try {
									const lists = await scanOneTarget(
										dotnetCli,
										targetPath,
										label,
										abort.signal
									);
									allVulnerable.push(...lists.vulnerable);
									allOutdated.push(...lists.outdated);
									allDeprecated.push(...lists.deprecated);
									allPatch.push(...lists.patch);
								} catch (solutionError: any) {
									logger.error(`Solution taranamadı (${targetPath}): ${solutionError.message}`);
									if (String(solutionError.message).includes("`dotnet` komutu bulunamadı")) {
										abort.abort();
										throw solutionError;
									}
								}
							});

							vulnerable = mergeById(allVulnerable);
							outdated = mergeById(allOutdated);
							deprecated = mergeById(allDeprecated);
							patch = mergeById(allPatch);
						} else {
							// 2. Solution yoksa TÜM projeleri tara
							const projects = await workspaceScanner.findProjects();

							if (projects.length === 0) {
								vscode.window.showErrorMessage(
									"Workspace içinde hiç .sln veya .csproj dosyası bulunamadı."
								);
								return;
							}

							logger.info(`${projects.length} proje bulundu, hepsi taranacak...`);

							const allVulnerable: any[] = [];
							const allOutdated: any[] = [];
							const allDeprecated: any[] = [];
							const allPatch: any[] = [];

							await runPool(projects.length, PROJECT_SCAN_CONCURRENCY, token, async (index) => {
								const project = projects[index];
								const label = workspaceScanner.getProjectName(project);
								progress.report({ message: `${index + 1}/${projects.length} ${label}` });
								logger.info(`Taranıyor: ${project.fsPath}`);

								try {
									const lists = await scanOneTarget(
										dotnetCli,
										project.fsPath,
										label,
										abort.signal
									);
									allVulnerable.push(...lists.vulnerable);
									allOutdated.push(...lists.outdated);
									allDeprecated.push(...lists.deprecated);
									allPatch.push(...lists.patch);
								} catch (projectError: any) {
									logger.error(`Proje taranamadı (${project.fsPath}): ${projectError.message}`);
									if (String(projectError.message).includes("`dotnet` komutu bulunamadı")) {
										abort.abort();
										throw projectError;
									}
								}
							});

							vulnerable = mergeById(allVulnerable);
							outdated = mergeById(allOutdated);
							deprecated = mergeById(allDeprecated);
							patch = mergeById(allPatch);
						}

						if (token.isCancellationRequested) {
							logger.info("Tarama iptal edildi. Sonuç çizilmedi.");
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
							logger.error(`Transitive üst paket okunamadı: ${originError.message}`);
						}

						ScanState.setResults(vulnerable, outdated, deprecated);

						try {
							await loadAdvisoryCatalog();
						} catch (advisoryError: any) {
							logger.error(`Advisory kaydı okunamadı: ${advisoryError.message}`);
						}

						try {
							await loadReleaseAges();
						} catch (ageError: any) {
							logger.error(`Yaş kaydı okunamadı: ${ageError.message}`);
						}

						treeProvider.refresh();

						try {
							await refreshCentralPackages(workspaceScanner);
							logger.info(
								ScanState.getCpm()
									? `CPM: ${ScanState.getCentralVersionCount()} sürüm`
									: "CPM: yok"
							);
						} catch (cpmError: any) {
							logger.error(`CPM okunamadı: ${cpmError.message}`);
						}

						try {
							await refreshNuGetSources(workspaceScanner);
						} catch (sourceError: any) {
							logger.error(`NuGet.config okunamadı: ${sourceError.message}`);
						}

						try {
							const noticed = await workspaceScanner.findProjects();
							const gap = await workspaceHasAuditDataGap(noticed.map((project) => project.fsPath));
							ScanState.setAuditDataGap(gap);
						} catch (auditNoticeError: any) {
							logger.error(`Audit kaynağı uyarısı okunamadı: ${auditNoticeError.message}`);
						}

						paintScanStatus(statusBarItem);

						try {
							await saveLastScan(context.workspaceState);
						} catch (saveError: any) {
							logger.error(`Son tarama kaydedilemedi: ${saveError.message}`);
						}

						const message = `Tarama tamamlandı → Vulnerable: ${vulnerable.length}, Outdated: ${outdated.length}, Deprecated: ${deprecated.length}`;
						vscode.window.showInformationMessage(message);
						logger.info(message);

						// Update Dashboard If Open
						HealthDashboardPanel.refreshIfOpen();

						codeActionProvider.clearCache();
						codeLensProvider.refresh();
						try {
							await auditDiagnostics.refresh();
							void codeActionProvider.prefetch(auditDiagnostics.affectedProjects())
								.finally(() => {
									logger.info("CodeLens patch listesi hazır.");
									codeLensProvider.refresh();
								});
						} catch (diagError: any) {
							logger.error(`Quick Fix tanı hatası: ${diagError.message}`);
						}

						//Graph
						DependencyGraphPanel.refreshIfOpen();

						// Detay log
						if (vulnerable.length > 0) {
							logger.info("--- Vulnerable Paketler ---");
							vulnerable.forEach((p: any) => {
								logger.info(
									`${p.id} ${p.version} [${p.severity || "unknown"}] (${p.projects.join(", ")})`
								);
							});
						}

						if (outdated.length > 0) {
							logger.info("--- Outdated Paketler ---");
							outdated.forEach((p: any) => {
								logger.info(
									`${p.id} ${p.version} → ${p.latestVersion || "?"} (${p.projects.join(", ")})`
								);
							});
						}

						if (deprecated.length > 0) {
							logger.info("--- Deprecated Paketler ---");
							deprecated.forEach((p: any) => {
								logger.info(`${p.id} ${p.version} (${p.projects.join(", ")})`);
							});
						}
					} catch (error: any) {
						if (token.isCancellationRequested) {
							logger.info("Tarama iptal edildi. Sonuç çizilmedi.");
							return;
						}

						const errorMessage = error.message || String(error);
						logger.error(`Tarama hatası: ${errorMessage}`);
						vscode.window.showErrorMessage(
							`PackageHub tarama hatası: ${errorMessage}`
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
				logger.info("Tarama zaten sürüyor. Bittiğinde bir kez daha çalışacak.");
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
				vscode.window.showWarningMessage("Güncellenecek paket bilgisi eksik.");
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
					`${packageId} paketinin bulunduğu proje eşleştirilemedi. Tüm projelere eklenmedi.`
				);
				logger.error(`Update iptal: proje eşleşmedi → ${packageId}`);
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
					`${packageId} için önerilen yeni sürüm yok.\n\nAynı paket adı ile NuGet'te daha yeni versiyon olmayabilir (ör. xunit → xunit.v3).\nYine de "dotnet add package ${packageId}" çalıştırılsın mı?`,
					{ modal: true },
					"Yine de Dene",
					"İptal"
				);

				if (cont !== "Yine de Dene") {
					return;
				}
			}

			const currentVersion = vulnerable?.version || outdated?.version;
			const heading = currentVersion
				? `${packageId} ${currentVersion} → ${version}`
				: `${packageId} → ${version}`;
			const confirm = await vscode.window.showWarningMessage(
				`${heading}\n\nGüncellenecek projeler:\n${projectNames}`,
				{ modal: true },
				"Evet, Güncelle"
			);

			if (confirm !== "Evet, Güncelle") {
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
								message: `${packageId} güncelleniyor → ${workspaceScanner.getProjectName(project)}`,
							});

							await dotnetCli.updatePackage(project.fsPath, packageId, version);
							logger.info(
								`Güncellendi: ${packageId} → ${version} (${project.fsPath})`
							);
						}

						// Restore
						progress.report({ message: "Restore çalışıyor..." });

						try {
							await restoreForProjects(projectsToUpdate.map((project) => project.fsPath));
							logger.info("Restore tamamlandı.");
						} catch (restoreError: any) {
							logger.error(`Restore hatası: ${restoreError.message}`);
							vscode.window.showWarningMessage(
								`Paket güncellendi ama restore başarısız: ${restoreError.message}`
							);
						}

						vscode.window.showInformationMessage(
							`${packageId} → ${version} (${projectsToUpdate.length} proje) güncellendi.`
						);

						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.error(`Update hatası: ${msg}`);
						vscode.window.showErrorMessage(`Güncelleme başarısız: ${msg}`);
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
			const editorIsProject = !!editor && editor.document.fileName.toLowerCase().endsWith(".csproj");
			if (!packageId && editor) {
				packageId = readPackageRef(
					editor.document.lineAt(editor.selection.active.line).text
				)?.id || "";
			}

			if (!packageId) {
				vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
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
					`${packageId} paketinin bulunduğu proje eşleştirilemedi. Kaldırma başlatılmadı.`
				);
				return;
			}

			const projectNames = targets
				.map((project) => workspaceScanner.getProjectName(project))
				.join("\n");
			const confirm = await vscode.window.showWarningMessage(
				`${packageId} kaldırılsın mı?\n\n${projectNames}`,
				{ modal: true },
				"Evet, Kaldır"
			);
			if (confirm !== "Evet, Kaldır") {
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
								message: `${packageId} kaldırılıyor → ${workspaceScanner.getProjectName(project)}`,
							});
							await dotnetCli.removePackage(project.fsPath, packageId);
							removed += 1;
							logger.info(`Kaldırıldı: ${packageId} (${project.fsPath})`);
						}

						vscode.window.showInformationMessage(`${packageId} kaldırıldı.`);
						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.show(true);
						logger.error(`Kaldırma hatası: ${msg}`);
						vscode.window.showErrorMessage(`Kaldırma başarısız: ${msg}`);
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
				vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
				return;
			}

			const url = advisorySuppressUrl(ref.id);
			if (!url) {
				vscode.window.showWarningMessage("Advisory adresi yok. Güncelleme başlatılmadı.");
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const updateSelectedCommand = vscode.commands.registerCommand(
		"packageHub.updateSelectedPackage",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Paket Seçilemedi");
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
				vscode.window.showWarningMessage("Paket seçilemedi.");
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
				vscode.window.showWarningMessage("Paket seçilemedi.");
				return;
			}

			const { vulnerable, outdated, deprecated } = ScanState.findPackage(item.packageId);
			const info = vulnerable || outdated || deprecated;
			const version = info?.version || (typeof item.version === "string" ? item.version : undefined);

			const lines = [
				`Paket: ${item.packageId}`,
				version ? `Mevcut: ${version}` : undefined,
				info?.latestVersion ? `Son sürüm: ${info.latestVersion}` : undefined,
				info?.severity ? `Severity: ${info.severity}` : undefined,
				info?.projects?.length ? `Projeler: ${info.projects.join(", ")}` : undefined,
			].filter(Boolean);

			vscode.window.showInformationMessage(lines.join(" | "));
		}
	);

	const openNugetCommand = vscode.commands.registerCommand(
		"packageHub.openNugetPage",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Paket seçilemedi.");
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
				vscode.window.showErrorMessage("Açık bir workspace bulunamadı.");
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "PackageHub",
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "Restore çalışıyor..." });

					try {
						const projects = await workspaceScanner.findProjects();
						const found = (await workspaceScanner.findSolutions()).map((item) => item.fsPath);
						if (classicSolutionPaths(found).length === 0 && projects.length === 0) {
							vscode.window.showErrorMessage(
								"Restore edilecek .sln veya .csproj bulunamadı."
							);
							return;
						}

						await restoreForProjects(projects.map((project) => project.fsPath));

						vscode.window.showInformationMessage("Restore tamamlandı.");
						logger.info("Restore tamamlandı.");

						await vscode.commands.executeCommand("packageHub.scanWorkspace");
					} catch (error: any) {
						const msg = error.message || String(error);
						logger.error(`Restore hatası: ${msg}`);
						vscode.window.showErrorMessage(`Restore başarısız: ${msg}`);
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
				vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
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
				vscode.window.showWarningMessage("Bu satırda paket bulunamadı.");
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
						`${packageId} için proje bulunamadı: ${requestedProject}`
					);
					return;
				}
				projectPath = match.fsPath;
			} else if (editor?.document.uri.fsPath.toLowerCase().endsWith(".csproj")) {
				projectPath = editor.document.uri.fsPath;
			} else if (projects.length === 1) {
				projectPath = projects[0].fsPath;
			} else if (projects.length === 0) {
				vscode.window.showErrorMessage("Workspace içinde hiç .csproj dosyası bulunamadı.");
				return;
			} else {
				const picked = await vscode.window.showQuickPick(
					projects.map((project) => ({
						label: workspaceScanner.getProjectName(project),
						description: project.fsPath,
						fsPath: project.fsPath,
					})),
					{ placeHolder: "Why için proje seç" }
				);
				if (!picked) {
					return;
				}
				projectPath = picked.fsPath;
			}

			if (!projectPath) {
				vscode.window.showErrorMessage("Workspace içinde hiç .csproj dosyası bulunamadı.");
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
					progress.report({ message: `${packageId} neden burada…` });

					try {
						const text = await dotnetCli.why(selectedProject, packageId);
						logger.show(true);
						logger.info(`Why: ${packageId} (${selectedProject})`);
						logger.appendLine(text);
						await DependencyGraphPanel.show(packageId);
						vscode.window.showInformationMessage(
							`${packageId} yolu açıldı. CLI metni Output kanalında.`
						);
					} catch (error: any) {
						const message = error.message || String(error);
						logger.show(true);
						logger.error(`Why başarısız: ${message}`);
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
				logger.error(`Sağlık raporu kopyalanamadı: ${error?.message || error}`);
				vscode.window.showErrorMessage("Sağlık raporu kopyalanamadı.");
				return;
			}
			vscode.window.showInformationMessage("Sağlık raporu panoya kopyalandı.");
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
				vscode.window.showInformationMessage("Açık yok.");
				return;
			}

			try {
				await vscode.env.clipboard.writeText(markdown);
			} catch (error: any) {
				logger.error(`Açık raporu kopyalanamadı: ${error?.message || error}`);
				vscode.window.showErrorMessage("Açık raporu kopyalanamadı.");
				return;
			}
			vscode.window.showInformationMessage("Açık raporu panoya kopyalandı.");
		}
	);

	const openAdvisoryCommand = vscode.commands.registerCommand(
		"packageHub.openAdvisory",
		async (url?: string) => {
			if (!url) {
				vscode.window.showWarningMessage("Advisory adresi yok. Güncelleme başlatılmadı.");
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	);

	const quickFixBlockedCommand = vscode.commands.registerCommand(
		"packageHub.quickFixBlocked",
		async (message?: string) => {
			vscode.window.showWarningMessage(
				message || "Patch sürümü yok. Güncelleme başlatılmadı."
			);
		}
	);

	const codeLensPendingCommand = vscode.commands.registerCommand(
		"packageHub.codeLensPending",
		async () => {
			vscode.window.showInformationMessage(
				"Patch listesi hazır olunca satırın üstündeki lens sürümü yazar. Latest bu satırda yok."
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
		logger.info(`Kayıt sonrası tarama: ${document.uri.fsPath}`);
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
			vscode.commands.executeCommand("packageHub.scanWorkspace");
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
	logger.info("PackageHub kapatıldı.");
}