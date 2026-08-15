import * as vscode from 'vscode';
import { DotnetCli } from "./services/DotnetCli";
import { WorkspaceScanner } from "./services/WorkspaceScanner";
import { logger } from "./utils/logger";
import { CacheService } from "./services/CacheService";
import { PackageHubTreeProvider } from "./tree/PackageHubTreeProvider";
import { PackageHoverProvider } from "./providers/PackageHoverProvider";
import { ScanState } from "./services/ScanState";
import { PackageDecorationProvider } from "./providers/PackageDecorationProvider";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

// Extension aktif olduğunda çalışan giriş noktası.
export function activate(context: vscode.ExtensionContext) {

	logger.info("PackageHub aktif edildi.");

	//Servisleri oluştur
	dotnetCli = new DotnetCli();
	workspaceScanner = new WorkspaceScanner();
	const cacheService = new CacheService();

	// Status Bar
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.tooltip = "PackageHub - Tıklayarak Health Dashboardu aç";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Tree View
	const treeProvider = new PackageHubTreeProvider();
	vscode.window.registerTreeDataProvider("packageHubExplorer", treeProvider);
	context.subscriptions.push(
		vscode.window.createTreeView("packageHubExplorer", {
			treeDataProvider: treeProvider,
			showCollapseAll: true
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

	// Package Decoration
	const decorationProvider = new PackageDecorationProvider();
	context.subscriptions.push({ dispose: () => decorationProvider.dispose() });

	//Komutlar

	//Hello World
	const helloCommand = vscode.commands.registerCommand('packageHub.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from PackageHub!');
	});

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
					cancellable: false
				},
				async (progress) => {
					progress.report({ message: "Paketler taranıyor..." });

					try {
						logger.info(`Tarama başlatıldı: ${workspaceRoot}`);

						//Önce solution ara.
						const solutions = await workspaceScanner.findSolutions();
						let targetPath: string | undefined;

						if (solutions.length > 0) {
							targetPath = solutions[0].fsPath;
							logger.info(`Solution bulundu: ${targetPath}`);
						}
						else {
							const projects = await workspaceScanner.findProjects();

							if (projects.length === 0) {
								vscode.window.showErrorMessage(
									"Workspace içinde hiç .sln veya .csproj dosyası bulunamadı."
								);

								return;
							}

							targetPath = projects[0].fsPath;
							logger.info(`Project bulundu: ${targetPath}`);
						}

						const vulnerableKey = `vulnerable:${targetPath}`;
						const outdatedKey = `outdated: ${targetPath}`;

						let vulnerable = cacheService.get<any[]>(vulnerableKey);
						let outdated = cacheService.get<any[]>(outdatedKey);

						if (vulnerable && outdated) {
							logger.info("Sonuçlar cache'ten geldi.");
						}
						else {
							progress.report({ message: "Paketler taranıyor..." });

							vulnerable = await dotnetCli.listVulnerable(targetPath);
							outdated = await dotnetCli.listOutdated(targetPath);

							cacheService.set(vulnerableKey, vulnerable);
							cacheService.set(outdatedKey, outdated);

							logger.info("Tarama tamamlandı ve cache'e yazıldı.");
						}

						//Sonuç mesajı
						const message = `Tarama tamamlandı -> Vulnerable: ${vulnerable.length}, Outdated: ${outdated.length}`;
						vscode.window.showInformationMessage(message);
						logger.info(message);

						// Status Bar'ı güncelle
						if (vulnerable.length > 0 || outdated.length > 0) {
							statusBarItem.text = `$(warning) ${vulnerable.length} vulnarable . ${outdated.length} outdated`;
							statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
						}
						else {
							statusBarItem.text = `$(check) Packages healthy`;
							statusBarItem.backgroundColor = undefined;
						}

						//Tree View Güncelle
						treeProvider.refresh(vulnerable.length, outdated.length);

						// Set Scan State
						ScanState.setResults(vulnerable, outdated);

						// Decoration Set
						decorationProvider.updateDecorations();

						context.subscriptions.push(
							vscode.window.onDidChangeActiveTextEditor(() => {
								decorationProvider.updateDecorations();
							})
						);

						//Detayları Output penceresine yaz.
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
							outdated.forEach((p) => {
								logger.info(
									`${p.id} ${p.version} → ${p.latestVersion || "?"} (${p.projects.join(", ")})`
								);
							});
						}
					} catch (error: any) {
						const errorMessage = error.message || String(error);
						logger.error(`Tarama hatası: ${errorMessage}`);
						vscode.window.showErrorMessage(`PackageHub tarama hatası: ${errorMessage}`);
					}
				}
			);
		}
	);

	const updateCommand = vscode.commands.registerCommand(
		"packageHub.updateVulnerable",
		async (args?: { packageId: string; version: string }) => {
			if (!args) {
				vscode.window.showInformationMessage("Update komutu argümansız çağrıldı.");
				return;
			}
			vscode.window.showInformationMessage(
				`Update isteniyor → ${args.packageId} → ${args.version} (henüz implement edilmedi)`
			);
		}
	);

	context.subscriptions.push(helloCommand, scanCommand, logger, updateCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {
	logger.info("PackageHub kapatıldı.");
}
