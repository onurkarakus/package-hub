import * as path from "path";
import * as vscode from "vscode";
import { DotnetCli } from "./services/DotnetCli";
import { WorkspaceScanner } from "./services/WorkspaceScanner";
import { logger } from "./utils/logger";
import { CacheService } from "./services/CacheService";
import { PackageHubTreeProvider } from "./tree/PackageHubTreeProvider";
import { PackageHoverProvider } from "./providers/PackageHoverProvider";
import { ScanState } from "./services/ScanState";
import { refreshCentralPackages } from "./services/CentralPackages";
import { restoreLastScan, saveLastScan } from "./services/LastScanStore";
import { buildHealthReport } from "./services/HealthReport";
import { isSafeChannelTarget, readPackageRef } from "./utils/nugetAudit";
import { PackageAuditDiagnostics } from "./providers/PackageAuditDiagnostics";
import { PackageCodeActionProvider } from "./providers/PackageCodeActionProvider";
import { PackageCodeLensProvider } from "./providers/PackageCodeLensProvider";
import { HealthDashboardPanel } from "./webview/HealthDashboardPanel";
import { DependencyGraphPanel } from "./webview/DependencyGraphPanel";

let dotnetCli: DotnetCli;
let workspaceScanner: WorkspaceScanner;

const PROJECT_SCAN_CONCURRENCY = 2;

interface TargetScan {
	vulnerable: any[];
	outdated: any[];
	deprecated: any[];
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
		track("vulnerable", cli.listVulnerable(targetPath, false, signal)),
		track("outdated", cli.listOutdated(targetPath, false, "latest", signal)),
		track("deprecated", cli.listDeprecated(targetPath, signal)),
	]);

	if (settled.some((result) =>
		result.status === "rejected"
		&& String(result.reason?.message || result.reason).includes("`dotnet` komutu bulunamadı")
	)) {
		throw new Error("`dotnet` komutu bulunamadı. .NET SDK yüklü mü?");
	}

	const names = ["vulnerable", "outdated", "deprecated"] as const;
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
	};
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
					const listed = await dotnetCli.listOutdated(project.fsPath, false, channel);
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
				const solutions = (await workspaceScanner.findSolutions()).filter((item) =>
					item.fsPath.toLowerCase().endsWith(".sln")
				);
				if (solutions.length > 0) {
					await dotnetCli.restore(solutions[0].fsPath);
				} else {
					for (const project of projects) {
						await dotnetCli.restore(project.fsPath);
					}
				}

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
	const vulnerable = ScanState.getVulnerable();
	const outdated = ScanState.getOutDated();
	const deprecated = ScanState.getDeprecated();

	if (vulnerable.length > 0 || outdated.length > 0) {
		item.text = `$(warning) ${vulnerable.length} vuln · ${outdated.length} outdated · ${deprecated.length} deprecated`;
		item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		item.text = `$(check) Packages healthy`;
		item.backgroundColor = undefined;
	}
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
	context.subscriptions.push(
		vscode.window.createTreeView("packageHubExplorer", {
			treeDataProvider: treeProvider,
			showCollapseAll: true,
		})
	);

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
		codeLensProvider.refresh();
	}

	void refreshCentralPackages(workspaceScanner)
		.then(() => {
			treeProvider.refresh();
			HealthDashboardPanel.refreshIfOpen();
		})
		.catch((error: any) => {
			logger.error(`CPM okunamadı: ${error.message}`);
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
		}

		return Array.from(map.values());
	}

	const ignorePackageCommand = vscode.commands.registerCommand(
		"packageHub.ignorePackage",
		async (packageId?: string) => {

			if (packageId && typeof packageId === "object") {
				packageId = (packageId as any).packageId;
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

			const config = vscode.workspace.getConfiguration("packageHub");
			const current = config.get<string[]>("ignoredPackages", []);

			if (current.some((id) => id.toLowerCase() === packageId.toLowerCase())) {
				vscode.window.showInformationMessage(`${packageId} zaten ignore listesinde.`);
				return;
			}

			await config.update("ignoredPackages", [...current, packageId], vscode.ConfigurationTarget.Workspace);

			vscode.window.showInformationMessage(`${packageId} ignore listesine eklendi.`);
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

						// 1. Solution ara
						const solutions = (await workspaceScanner.findSolutions()).filter((s) =>
							s.fsPath.toLowerCase().endsWith(".sln")
						);

						if (token.isCancellationRequested) {
							logger.info("Tarama iptal edildi. Sonuç çizilmedi.");
							return;
						}

						if (solutions.length > 0) {
							const targetPath = solutions[0].fsPath;
							const label = path.basename(targetPath);
							logger.info(`Solution bulundu: ${targetPath}`);
							progress.report({ message: `1/1 ${label}` });

							const lists = await scanOneTarget(dotnetCli, targetPath, label, abort.signal);
							vulnerable = lists.vulnerable;
							outdated = lists.outdated;
							deprecated = lists.deprecated;
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

						vulnerable = vulnerable.filter((p) => !ignored.includes(p.id.toLowerCase()));
						outdated = outdated.filter((p) => !ignored.includes(p.id.toLowerCase()));
						deprecated = deprecated.filter((p) => !ignored.includes(p.id.toLowerCase()));

						ScanState.setResults(vulnerable, outdated, deprecated);

						paintScanStatus(statusBarItem);
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
							const solutions = (await workspaceScanner.findSolutions()).filter((s) =>
								s.fsPath.toLowerCase().endsWith(".sln")
							);

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

	const updateHighestPatchCommand = vscode.commands.registerCommand(
		"packageHub.updateHighestPatch",
		() => applySafeUpdate("patch")
	);

	const updateHighestMinorCommand = vscode.commands.registerCommand(
		"packageHub.updateHighestMinor",
		() => applySafeUpdate("minor")
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
						const solutions = (await workspaceScanner.findSolutions()).filter((s) =>
							s.fsPath.toLowerCase().endsWith(".sln")
						);

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

			await vscode.env.clipboard.writeText(markdown);
			vscode.window.showInformationMessage("Sağlık raporu panoya kopyalandı.");
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
		showPackageInfoCommand,
		openNugetCommand,
		restoreAllCommand,
		showGraphCommand,
		whyPackageCommand,
		copyHealthReportCommand,
		explainCommand,
		ignorePackageCommand,
		unignorePackageCommand,
		openAdvisoryCommand,
		quickFixBlockedCommand,
		codeLensPendingCommand,
		logger
	);

	const scanOnStartup = vscode.workspace
		.getConfiguration("packageHub")
		.get<boolean>("scanOnStartup", true);

	if (scanOnStartup && workspaceScanner.getWorkspaceRoot()) {
		setTimeout(() => {
			vscode.commands.executeCommand("packageHub.scanWorkspace");
		}, 2000);
	}
}

export function deactivate() {
	logger.info("PackageHub kapatıldı.");
}