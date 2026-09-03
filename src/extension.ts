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
import { version } from "node:os";
import { DependencyGraphPanel } from "./webview/DependencyGraphPanel";

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

	const projectFileWatcher = vscode.workspace.createFileSystemWatcher(
		"**/*.{csproj,props}"
	);

	const onProjectFileChanged = () => {
		logger.info("Proje dosyası değişti, dekorasyon yenileniyor.");
		decorationProvider.updateDecorations();
	};

	projectFileWatcher.onDidChange(onProjectFileChanged);
	projectFileWatcher.onDidCreate(onProjectFileChanged);
	projectFileWatcher.onDidDelete(onProjectFileChanged);

	context.subscriptions.push(
		projectFileWatcher,
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.fileName.endsWith(".csproj") || doc.fileName.endsWith(".props")) {
				logger.info(`Kaydedildi: ${doc.fileName}`);
				decorationProvider.updateDecorations();
			}
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

	function mergeById(packages: any[]): any[] {
		const map = new Map<string, any>();

		for (const p of packages) {
			const key = p.id.toLowerCase();
			const existing = map.get(key);

			if (!existing) {
				map.set(key, {
					...p,
					projects: [...(p.projects || [])],
				});
				continue;
			}

			for (const proj of p.projects || []) {
				if (!existing.projects.includes(proj)) {
					existing.projects.push(proj);
				}
			}

			if (p.latestVersion && !existing.latestVersion) {
				existing.latestVersion = p.latestVersion;
			}
		}

		return Array.from(map.values());
	}

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
						let deprecated: any[] = [];

						// 1. Solution ara
						const solutions = await workspaceScanner.findSolutions();

						if (solutions.length > 0) {
							const targetPath = solutions[0].fsPath;
							logger.info(`Solution bulundu: ${targetPath}`);

							vulnerable = await dotnetCli.listVulnerable(targetPath, false);
							outdated = await dotnetCli.listOutdated(targetPath, false);
							deprecated = await dotnetCli.listDeprecated(targetPath);
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

							for (const project of projects) {
								logger.info(`Taranıyor: ${project.fsPath}`);
								const vul = await dotnetCli.listVulnerable(project.fsPath, false);
								const out = await dotnetCli.listOutdated(project.fsPath, false);
								const dep = await dotnetCli.listDeprecated(project.path);

								allVulnerable.push(...vul);
								allOutdated.push(...out);
								allDeprecated.push(...dep);
							}

							vulnerable = mergeById(allVulnerable);
							outdated = mergeById(allOutdated);
							deprecated = mergeById(allDeprecated);
						}

						// Sonuç mesajı
						const message = `Tarama tamamlandı → Vulnerable: ${vulnerable.length}, Outdated: ${outdated.length}, Deprecated: ${deprecated.length}`;
						vscode.window.showInformationMessage(message);
						logger.info(message);

						// Status Bar
						if (vulnerable.length > 0 || outdated.length > 0) {
							statusBarItem.text = `$(warning) ${vulnerable.length} vuln · ${outdated.length} outdated · ${deprecated.length} deprecated`;
							statusBarItem.backgroundColor = new vscode.ThemeColor(
								"statusBarItem.warningBackground"
							);
						} else {
							statusBarItem.text = `$(check) Packages healthy`;
							statusBarItem.backgroundColor = undefined;
						}

						// Tree View
						treeProvider.refresh();

						// Scan State (Hover + Decorations için)
						ScanState.setResults(vulnerable, outdated, deprecated);

						// Update Dashboard If Open
						HealthDashboardPanel.refreshIfOpen();

						// Decorations
						decorationProvider.updateDecorations();

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

			const confirm = await vscode.window.showWarningMessage(
				`${packageId} → ${version}\n\nGüncellenecek projeler:\n${projectNames}`,
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
							const solutions = await workspaceScanner.findSolutions();

							if (solutions.length > 0) {
								logger.info(`Restore solution: ${solutions[0].fsPath}`);
								await dotnetCli.restore(solutions[0].fsPath);
							} else {
								for (const project of projectsToUpdate) {
									logger.info(`Restore project: ${project.fsPath}`);
									await dotnetCli.restore(project.fsPath);
								}
							}

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

	const showPackageInfoCommand = vscode.commands.registerCommand(
		"packageHub.showPackageInfo",
		async (item?: any) => {
			if (!item?.packageId) {
				vscode.window.showWarningMessage("Paket seçilemedi.");
				return;
			}

			const { vulnerable, outdated, deprecated } = ScanState.findPackage(item.packageId);
			const info = vulnerable || outdated || deprecated;

			const lines = [
				`Paket: ${item.packageId}`,
				info?.version ? `Mevcut: ${info.version}` : undefined,
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
						const solutions = await workspaceScanner.findSolutions();

						if (solutions.length > 0) {
							// Solution varsa onu restore et
							const solutionPath = solutions[0].fsPath;
							logger.info(`Restore solution: ${solutionPath}`);
							await dotnetCli.restore(solutionPath);
						} else {
							// Solution yoksa tüm projeleri restore et
							const projects = await workspaceScanner.findProjects();
							if (projects.length === 0) {
								vscode.window.showErrorMessage(
									"Restore edilecek .sln veya .csproj bulunamadı."
								);
								return;
							}

							for (const project of projects) {
								progress.report({
									message: `Restore: ${workspaceScanner.getProjectName(project)}`,
								});
								logger.info(`Restore project: ${project.fsPath}`);
								await dotnetCli.restore(project.fsPath);
							}
						}

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
		() => {
			DependencyGraphPanel.createOrShow();
		}
	);

	context.subscriptions.push(
		scanCommand,
		updateCommand,
		showDashboardCommand,
		updateSelectedCommand,
		showPackageInfoCommand,
		openNugetCommand,
		restoreAllCommand,
		showGraphCommand,
		logger
	);

	const scanOnStartup = vscode.workspace
		.getConfiguration("packageHub")
		.get<boolean>("scanOnStartup", true);

	if (scanOnStartup && workspaceScanner.getWorkspaceRoot()) {
		vscode.commands.executeCommand("packageHub.scanWorkspace");
	}
}

export function deactivate() {
	logger.info("PackageHub kapatıldı.");
}