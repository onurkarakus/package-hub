import * as vscode from "vscode";
import { DotnetCli } from "./services/DotnetCli";
import { WorkspaceScanner } from "./services/WorkspaceScanner";
import { logger } from "./utils/logger";
import { CacheService } from "./services/CacheService";
import { PackageHubTreeProvider } from "./tree/PackageHubTreeProvider";
import { PackageHoverProvider } from "./providers/PackageHoverProvider";
import { ScanState } from "./services/ScanState";
import { PackageDecorationProvider } from "./providers/PackageDecorationProvider";
import { HealthDashboardPanel } from "./webview/HealthDashboardPanel";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

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
	vscode.window.registerTreeDataProvider("packageHubExplorer", treeProvider);
	context.subscriptions.push(
		vscode.window.createTreeView("packageHubExplorer", {
			treeDataProvider: treeProvider,
			showCollapseAll: true,
		})
	);

	// Hover
	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ language: "xml", pattern: "**/*.{csproj,props}" },
			{ language: "xml", scheme: "file" },
		],
		new PackageHoverProvider()
	);
	context.subscriptions.push(hoverProvider);

	// Decorations
	const decorationProvider = new PackageDecorationProvider();
	context.subscriptions.push({ dispose: () => decorationProvider.dispose() });

	// Editör değiştiğinde dekorasyonları güncelle (sadece bir kere kaydet)
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			decorationProvider.updateDecorations();
		})
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

	const helloCommand = vscode.commands.registerCommand(
		"packageHub.helloWorld",
		() => {
			vscode.window.showInformationMessage("Hello World from PackageHub!");
		}
	);

	const scanCommand = vscode.commands.registerCommand(
		"packageHub.scanWorkspace",
		async () => {
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
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "Paketler taranıyor..." });

					try {
						logger.info(`Tarama başlatıldı: ${workspaceRoot}`);

						// Her taramada cache’i temizle (şimdilik stabilite için)
						cacheService.invalidateAll();

						let vulnerable: any[] = [];
						let outdated: any[] = [];

						// 1. Solution ara
						const solutions = await workspaceScanner.findSolutions();

						if (solutions.length > 0) {
							const targetPath = solutions[0].fsPath;
							logger.info(`Solution bulundu: ${targetPath}`);

							vulnerable = await dotnetCli.listVulnerable(targetPath, false);
							outdated = await dotnetCli.listOutdated(targetPath, false);
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

							for (const project of projects) {
								logger.info(`Taranıyor: ${project.fsPath}`);
								const vul = await dotnetCli.listVulnerable(project.fsPath, false);
								const out = await dotnetCli.listOutdated(project.fsPath, false);

								allVulnerable.push(...vul);
								allOutdated.push(...out);
							}

							// Duplicate temizle (id’ye göre)
							vulnerable = Array.from(
								new Map(
									allVulnerable.map((p) => [p.id.toLowerCase(), p])
								).values()
							);
							outdated = Array.from(
								new Map(
									allOutdated.map((p) => [p.id.toLowerCase(), p])
								).values()
							);
						}

						// Sonuç mesajı
						const message = `Tarama tamamlandı → Vulnerable: ${vulnerable.length}, Outdated: ${outdated.length}`;
						vscode.window.showInformationMessage(message);
						logger.info(message);

						// Status Bar
						if (vulnerable.length > 0 || outdated.length > 0) {
							statusBarItem.text = `$(warning) ${vulnerable.length} vulnerable · ${outdated.length} outdated`;
							statusBarItem.backgroundColor = new vscode.ThemeColor(
								"statusBarItem.warningBackground"
							);
						} else {
							statusBarItem.text = `$(check) Packages healthy`;
							statusBarItem.backgroundColor = undefined;
						}

						// Tree View
						treeProvider.refresh(vulnerable.length, outdated.length);

						// Scan State (Hover + Decorations için)
						ScanState.setResults(vulnerable, outdated);

						// Update Dashboard If Open
						HealthDashboardPanel.refreshIfOpen();

						// Decorations
						decorationProvider.updateDecorations();

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
					} catch (error: any) {
						const errorMessage = error.message || String(error);
						logger.error(`Tarama hatası: ${errorMessage}`);
						vscode.window.showErrorMessage(
							`PackageHub tarama hatası: ${errorMessage}`
						);
					}
				}
			);
		}
	);

	const updateCommand = vscode.commands.registerCommand(
		"packageHub.updateVulnerable",
		async (args?: { packageId: string; version: string }) => {
			if (!args) {
				vscode.window.showInformationMessage(
					"Update komutu argümansız çağrıldı."
				);
				return;
			}
			vscode.window.showInformationMessage(
				`Update isteniyor → ${args.packageId} → ${args.version} (henüz implement edilmedi)`
			);
		}
	);

	context.subscriptions.push(
		helloCommand,
		scanCommand,
		updateCommand,
		showDashboardCommand,
		logger
	);
}

export function deactivate() {
	logger.info("PackageHub kapatıldı.");
}