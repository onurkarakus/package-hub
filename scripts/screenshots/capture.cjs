// Captures the README and walkthrough screenshots by driving a real VS Code
// window with PackageHub installed. Nothing here is mocked: the scan runs
// `dotnet` against a copy of samples/contoso-shop and reads nuget.org.
//
// Needs Linux with Xvfb, the .NET SDK (8.0.400 or newer) on the PATH that
// VS Code sees, network access to nuget.org, and playwright-core (not a
// project dependency):
//
//   npm ci
//   npm i --no-save playwright-core
//   npx @vscode/vsce package --no-dependencies -o /tmp/packagehub.vsix
//   xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/screenshots/capture.cjs \
//     --vsix /tmp/packagehub.vsix --out docs/images
//
// To refresh the walkthrough step images too, run the dark session with
// --walkthrough-media first, package again so the new images are inside the
// .vsix, then capture the walkthrough shots:
//
//   ... capture.cjs --vsix /tmp/packagehub.vsix --session dark --walkthrough-media \
//         --only line-marks,hover,quick-fix,tree,dashboard,why
//   npx @vscode/vsce package --no-dependencies -o /tmp/packagehub.vsix
//   ... capture.cjs --vsix /tmp/packagehub.vsix --session dark --only walkthrough
//   ... capture.cjs --vsix /tmp/packagehub.vsix --session light
//
// Options:
//   --code <path>        VS Code executable. Default: stable, downloaded with @vscode/test-electron.
//   --vsix <path>        The packaged extension to install (required).
//   --workspace <path>   New folder for the sample copy; must not exist. Default: a new temp folder.
//   --out <dir>          Output folder. Default: docs/images.
//   --session dark|light|all   Default: all.
//   --only a,b           Only these shots: line-marks, hover, quick-fix, tree,
//                        dashboard, why, walkthrough.
//   --walkthrough-media  Also save the walkthrough step images in media/walkthrough.
//   --playwright <path>  Where playwright-core is. Default: resolved from node_modules.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const { _electron } = require(arg("playwright", "playwright-core"));

const vsix = path.resolve(arg("vsix", ""));
// The sample is copied to a new folder. A --workspace path must not exist yet,
// so the script never deletes or overwrites a folder it did not create.
const workspaceArg = arg("workspace");
const workspace = workspaceArg ? path.resolve(workspaceArg) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ph-shot-ws-")), "contoso-shop");
const out = path.resolve(arg("out", path.join(repo, "docs", "images")));
const only = arg("only");
const walkthroughMedia = flag("walkthrough-media");
const WIDTH = 1600;
const HEIGHT = 1000;
const want = (name) => !only || only.split(",").includes(name);
fs.mkdirSync(out, { recursive: true });

const resolveCode = async () => {
  const given = arg("code");
  if (given) return given;
  const { downloadAndUnzipVSCode } = require(path.join(repo, "node_modules", "@vscode", "test-electron"));
  return downloadAndUnzipVSCode({ version: "stable", cachePath: path.join(repo, ".vscode-test") });
};

// Copies the sample so restore output and VS Code state stay out of the repo.
const prepareWorkspace = () => {
  if (fs.existsSync(workspace)) {
    throw new Error(`${workspace} already exists. Pass a --workspace path that does not exist, or leave it out.`);
  }
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  fs.cpSync(path.join(repo, "samples", "contoso-shop"), workspace, {
    recursive: true,
    filter: (src) => !/[\\/](bin|obj)$/.test(src),
  });
  execFileSync("dotnet", ["restore", "ContosoShop.sln"], { cwd: workspace, stdio: "pipe" });
};

const settingsFor = (theme) => ({
  "workbench.colorTheme": theme,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.editor.empty.hint": "hidden",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  // Hides the chat UI so it does not take space in the screenshots.
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "window.commandCenter": false,
  "window.title": "${rootName}",
  "window.restoreWindows": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.ignoreRecommendations": true,
  "extensions.autoCheckUpdates": false,
  "security.workspace.trust.enabled": false,
  "editor.fontSize": 15,
  "editor.lineHeight": 24,
  "editor.fontFamily": "'Cascadia Code', 'DejaVu Sans Mono', monospace",
  "editor.minimap.enabled": false,
  "editor.stickyScroll.enabled": false,
  "editor.hover.delay": 200,
  "editor.renderWhitespace": "none",
  "breadcrumbs.enabled": false,
  "git.enabled": false,
  "workbench.statusBar.visible": true,
  "files.exclude": { "**/bin": true, "**/obj": true },
});

// Workbench commands are bound to spare keys so the script runs them by id,
// not by a Command Palette title that can change between VS Code versions.
const KEYS = {
  "notifications.clearAll": "ctrl+alt+shift+f1",
  "notifications.toggleDoNotDisturbMode": "ctrl+alt+shift+f2",
  "workbench.action.closePanel": "ctrl+alt+shift+f3",
  "workbench.action.increaseViewWidth": "ctrl+alt+shift+f4",
  "workbench.action.closeAllEditors": "ctrl+alt+shift+f5",
  "packageHubExplorer.focus": "ctrl+alt+shift+f6",
  "packageHub.showHealthDashboard": "ctrl+alt+shift+f7",
  "packageHub.whyPackage": "ctrl+alt+shift+f8",
  "packageHub.openWalkthrough": "ctrl+alt+shift+f9",
  "editor.action.hideHover": "ctrl+alt+shift+f10",
  "workbench.action.toggleSidebarVisibility": "ctrl+alt+shift+f11",
};
const toPlaywright = (key) => key.split("+").map((part) => ({ ctrl: "Control", alt: "Alt", shift: "Shift" }[part] ?? part.toUpperCase())).join("+");

const launch = async (code, theme) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ph-shot-"));
  const extDir = path.join(userData, "extensions");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify(settingsFor(theme), null, 2));
  fs.writeFileSync(
    path.join(userData, "User", "keybindings.json"),
    JSON.stringify(Object.entries(KEYS).map(([command, key]) => ({ key, command })), null, 2)
  );
  const cli = path.join(path.dirname(code), "bin", "code");
  execFileSync(cli, [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, "--install-extension", vsix], { stdio: "pipe" });
  const app = await _electron.launch({
    executablePath: code,
    args: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-gpu", "--no-sandbox"],
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(size.w, size.h);
    win.setPosition(0, 0);
  }, { w: WIDTH, h: HEIGHT });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(3000);
  return { app, page };
};

const helpers = (page) => {
  const wait = (ms) => page.waitForTimeout(ms);
  const command = async (title) => {
    await page.keyboard.press("F1");
    await wait(300);
    await page.keyboard.type(title, { delay: 5 });
    await wait(600);
    if (process.env.SHOT_DEBUG) await page.screenshot({ path: path.join(out, `debug-${title.replace(/\W+/g, "_")}.png`) });
    await page.keyboard.press("Enter");
    await wait(900);
  };
  const run = async (id, pause = 700) => {
    await page.keyboard.press(toPlaywright(KEYS[id]));
    await wait(pause);
  };
  const open = async (file, line, column = 1) => {
    await page.keyboard.press("Control+P");
    await wait(300);
    await page.keyboard.type(file, { delay: 5 });
    await wait(800);
    await page.keyboard.press("Enter");
    await wait(1000);
    if (line) {
      await page.keyboard.press("Control+G");
      await wait(200);
      await page.keyboard.type(`${line}:${column}`);
      await page.keyboard.press("Enter");
      await wait(400);
    }
  };
  const shot = async (name, clip) => {
    await wait(600);
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
    console.log(file);
    return file;
  };
  // Saves one part of the window (".part.editor", ".part.sidebar") for the walkthrough.
  // `area` is relative to the part: { x, y, width, height }.
  const part = async (name, selector, area) => {
    if (!walkthroughMedia) return;
    const file = path.join(repo, "media", "walkthrough", `${name}.png`);
    const box = await page.locator(selector).first().boundingBox();
    const clip = area
      ? { x: box.x + area.x, y: box.y + area.y, width: Math.min(area.width, box.width - area.x), height: Math.min(area.height, box.height - area.y) }
      : box;
    await page.screenshot({ path: file, clip });
    console.log(file);
  };
  const toggleSideBar = () => run("workbench.action.toggleSidebarVisibility", 800);
  const escape = async (times = 2) => {
    for (let i = 0; i < times; i++) {
      await page.keyboard.press("Escape");
      await wait(150);
    }
  };
  const quiet = async () => {
    await run("notifications.clearAll");
    await run("workbench.action.closePanel");
  };
  // Makes the side bar wider so package names and descriptions fit.
  const widenSideBar = async (width) => {
    const sidebar = page.locator(".part.sidebar");
    const box = await sidebar.boundingBox();
    if (!box) return;
    const sash = page.locator(".monaco-sash.vertical");
    for (let i = 0; i < (await sash.count()); i++) {
      const s = await sash.nth(i).boundingBox();
      if (s && Math.abs(s.x + s.width / 2 - (box.x + box.width)) < 6 && s.height > 200) {
        const x = s.x + s.width / 2;
        const y = s.y + s.height / 2;
        await page.mouse.move(x, y);
        await wait(300);
        await page.mouse.down();
        await page.mouse.move(x + 40, y, { steps: 4 });
        await page.mouse.move(box.x + width, y, { steps: 12 });
        await page.mouse.up();
        await page.mouse.move(800, 8);
        break;
      }
    }
    await wait(500);
    const after = await sidebar.boundingBox();
    console.log(`side bar width ${Math.round(box.width)} -> ${Math.round(after?.width ?? 0)}`);
  };
  const treeRow = (label) => page.locator(".pane-body .monaco-list-row", { hasText: label }).first();
  // Waits for the startup scan: the Package Health tree swaps "Scan Now" for its sections.
  const waitForScan = async () => {
    await run("packageHubExplorer.focus");
    await treeRow("Vulnerable").waitFor({ timeout: 240000 });
    await wait(2500);
  };
  const expand = async (label) => {
    const row = treeRow(label);
    if ((await row.getAttribute("aria-expanded")) === "false") {
      await row.click();
      await wait(600);
    }
  };
  const collapse = async (label) => {
    const row = treeRow(label);
    if ((await row.getAttribute("aria-expanded")) === "true") {
      await row.click();
      await wait(400);
    }
  };
  return { toggleSideBar, widenSideBar, wait, run, command, open, shot, part, escape, quiet, waitForScan, expand, collapse, treeRow };
};

const darkSession = async (code) => {
  const { app, page } = await launch(code, "Default Dark Modern");
  const h = helpers(page);
  await h.run("notifications.toggleDoNotDisturbMode");
  await h.waitForScan();
  await h.widenSideBar(520);
  await h.quiet();
  await h.expand("Vulnerable");
  await h.open("Directory.Packages.props", 6, 1);
  await h.escape();
  await h.wait(1500);

  if (want("line-marks")) {
    await h.shot("01-line-marks-dark");
    await h.part("marks", ".part.editor", { x: 0, y: 0, width: 820, height: 520 });
  }
  if (want("hover")) {
    await h.open("Directory.Packages.props", 6, 32);
    await page.keyboard.press("Control+K");
    await page.keyboard.press("Control+I");
    await h.wait(2000);
    await h.shot("02-hover-dark");
    await h.escape();
  }
  if (want("quick-fix")) {
    // System.Text.Json 8.0.0 in Shop.Core: highest patch 8.0.x first, then latest.
    await h.open("Shop.Core.csproj", 10, 35);
    // The first request reads the patch and latest lists with dotnet; the second one shows them all.
    await page.keyboard.press("Control+.");
    await h.wait(15000);
    await h.escape();
    await page.keyboard.press("Control+.");
    await h.wait(2500);
    await h.shot("03-quick-fix-dark");
    await h.part("quick-fix", ".part.editor", { x: 0, y: 220, width: 820, height: 280 });
    await h.escape();
  }
  if (want("tree")) {
    await h.expand("Outdated");
    await h.expand("Deprecated");
    await h.open("Shop.Api.csproj", 11, 1);
    await h.escape();
    await h.wait(1000);
    await h.shot("04-package-health-dark");
    await h.part("scan", ".part.sidebar", { x: 0, y: 0, width: 520, height: 720 });
    await h.collapse("Outdated");
    await h.collapse("Deprecated");
  }
  if (want("dashboard")) {
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
    await h.run("packageHub.showHealthDashboard");
    await h.wait(3000);
    await h.shot("05-dashboard-dark");
    await h.part("dashboard", ".part.editor", { x: 0, y: 0, width: 1000, height: 640 });
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
  }
  if (want("why")) {
    // Azure.Identity is transitive: Shop.Api -> Shop.Data -> Microsoft.Data.SqlClient -> Azure.Identity.
    await h.open("Shop.Api.csproj", 10, 1);
    await h.escape();
    await h.treeRow("Azure.Identity").click({ button: "right" });
    await h.wait(800);
    await page.locator(".context-view .action-label", { hasText: "Why is this here?" }).first().click();
    await h.wait(12000);
    await h.quiet();
    await h.wait(800);
    await h.shot("06-why-dark");
    await h.part("why", ".editor-group-container >> nth=1", { x: 0, y: 30, width: 700, height: 420 });
    await h.run("workbench.action.closeAllEditors");
  }
  if (want("walkthrough")) {
    await h.toggleSideBar();
    await h.run("packageHub.openWalkthrough");
    await h.wait(2500);
    await page.locator(".getting-started-step", { hasText: "Read the line marks" }).first().click();
    await h.wait(1500);
    await h.shot("07-walkthrough-dark");
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
  }
  await app.close();
};

const lightSession = async (code) => {
  const { app, page } = await launch(code, "Default Light Modern");
  const h = helpers(page);
  await h.run("notifications.toggleDoNotDisturbMode");
  await h.waitForScan();
  await h.widenSideBar(520);
  await h.quiet();
  await h.expand("Vulnerable");
  if (want("line-marks")) {
    await h.open("Directory.Packages.props", 6, 1);
    await h.escape();
    await h.wait(1500);
    await h.shot("01-line-marks-light");
  }
  if (want("dashboard")) {
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
    await h.run("packageHub.showHealthDashboard");
    await h.wait(3000);
    await h.shot("05-dashboard-light");
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
  }
  if (want("walkthrough")) {
    await h.toggleSideBar();
    await h.run("packageHub.openWalkthrough");
    await h.wait(2500);
    await page.locator(".getting-started-step", { hasText: "Apply a safe update" }).first().click();
    await h.wait(1500);
    await h.shot("07-walkthrough-light");
    await h.run("workbench.action.closeAllEditors");
    await h.toggleSideBar();
  }
  await app.close();
};

(async () => {
  if (!fs.existsSync(vsix)) throw new Error("Pass --vsix with a packaged PackageHub .vsix");
  const code = await resolveCode();
  prepareWorkspace();
  const session = arg("session", "all");
  if (session === "all" || session === "dark") await darkSession(code);
  if (session === "all" || session === "light") await lightSession(code);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
