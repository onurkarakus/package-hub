# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-22

### Added

- **Add Package**: a command, a **+** button in the Package Health view and an **Add package** tab in the dashboard. The local NuGet cache is searched as you type, offline. The package sources are searched only when you ask, through `dotnet package search` and your NuGet.config. Pick one or more projects and a version, read the summary and confirm. `dotnet add package` writes the reference, so Central Package Management is handled as usual. PackageHub does not read or store credentials.
- **Align Versions**: one click brings every direct reference of a package to the highest version already used inside the same major version. Available on version conflicts in the Package Health view, from the command palette and as a dashboard action, with the same confirmation. Nothing is downgraded, nothing crosses a major version, and projects that use different versions per target framework keep them.
- **What's in this update**: update, pin and add confirmations list the license (and license changes), the release notes and the added, dropped and changed dependencies, read from the `.nuspec` in the local NuGet cache. With `packageHub.onlineLookups` on, a missing `.nuspec` is read from nuget.org.
- `.slnx` solutions are scanned, restored and watched like `.sln` files. When a `.slnx` restore fails, its projects are restored one by one.
- Visual Basic projects (`.vbproj`) get the same scan, marks, hover, lightbulb and updates as C# and F# projects.
- **Remove Unused Central Versions** lists the `PackageVersion` entries in `Directory.Packages.props` that no project uses, previews them and removes the ones you pick. Nothing is removed when a project cannot be read.
- Version ranges, floating versions and `$(Property)` versions: a range update keeps the upper bound and stays inside the range, a floating version that already covers the target is restored instead of rewritten, and a property version is updated where the property is defined. A property set under a `Condition` is left for you to edit.
- Rollback: when one step of a bulk update, an alignment or an add fails, every file it touched is put back as it was. New setting `packageHub.rollbackOnFailure` (on by default).
- Line marks are clickable: hover a mark for **Update to …**, **Open Advisory** and **Why is this here?** links.
- New setting `packageHub.badge`: the view badge can count vulnerable packages (default), vulnerable and outdated, all three, or nothing.
- Turkish translation of the commands, settings, walkthrough, dashboard and messages. VS Code picks it from the display language; English stays the default.

### Changed

- `PackageHub: Scan Workspace` waits for a scan that is already running, so a command that scans after a change sees fresh results.
- The `packageHub.onlineLookups` description now names every lookup it allows: advisory ranges, publish dates and package metadata.


## [0.2.0] - 2026-11-09

### Upgrading

- `packageHub.dashboardViewMode` is gone. If it is still in your `settings.json`, nothing breaks: VS Code greys it out as an unknown setting and PackageHub never reads it. You can delete the line.
- `packageHub.updateVulnerable` still takes `packageId`, `version` and `projectName`, so existing keybindings and tasks keep working. The new `projects` argument is optional.
- The saved last scan keeps its format. A scan saved by 0.0.4 or 0.1.0 loads as before; run a new scan to fill in the per-advisory severities.
- 0.1.0 was not published to the Marketplace. Coming from 0.0.4, read the 0.1.0 notes below too. PackageHub now needs VS Code 1.74 or newer (0.0.4 needed 1.125), and it starts when the folder has a project, solution or `Directory.Packages.props` file, not when a loose C# or F# file opens.

### Changed

- New Health Dashboard: a health score with its breakdown, KPI cards, a package table you can search, filter, sort and expand (advisories, projects, the path that brings a transitive package in), recommended actions with Preview and Apply, a project heatmap and the feed status. It follows the color theme and is built from the last scan and local advisory data only.

### Fixed

- Dashboard updates only write the projects where the package is affected and older than the suggested version. `packageHub.updateVulnerable` never moves a project to an older version and lists the projects it leaves as they are.
- A transitive warning whose origins are all missing from the resolved graph no longer gets a suggested pin or a Pin button.
- The project heatmap counts each finding only in the projects where that report saw it.
- Vulnerable packages without an advisory link count in the score, the Vulnerable card and the Vulnerable filter.
- Preview lists every project the update writes, including the transitive ones that get a direct reference.
- The score estimate for the patch action keeps the advisories a patch leaves open, at their own severity, and the transitive occurrences the patch does not edit.
- The Package column keeps a minimum width; the table scrolls sideways in a narrow panel.
- Expanding a row with Enter or Space keeps the focus on that row.

### Removed

- The `packageHub.dashboardViewMode` setting. The table and the project heatmap replace the List, By project and By package layouts.

## [0.1.0] - 2026-11-05

### Added

- Local-first by default: PackageHub makes no network request of its own. Advisory ranges and publish dates are read from the NuGet cache `dotnet` already wrote. The new `packageHub.onlineLookups` setting (off by default) allows asking nuget.org when local data is missing.
- Feed health: the tree and the dashboard list the NuGet sources `dotnet` uses, whether each is enabled, which ones failed in the last scan or restore (NU1301, NU1302, NU1801, NU1900, NU1905), and credential provider hints.
- An update summary before every update: from and to versions, patch/minor/major, advisories closed or still open, direct or transitive, affected projects, whether a CPM file is edited, and prerelease and age warnings.
- Pinning a transitive package asks for its own confirmation.
- Version conflicts are found per project and target framework.
- Settings for `dotnet` timeouts and for how many `dotnet` processes run at once.
- `npm run test:min` runs the tests on the oldest supported VS Code. `npm run publish:ovsx` and PUBLISHING.md for Open VSX.
- **Get Started** walkthrough with seven steps: open a .NET project, run the first scan, read the line marks, apply a safe update from the lightbulb, open Package Health and the dashboard, ask "Why is this here?", and tune `minimumSeverity`, `includePrerelease` and `minimumReleaseAge`. Open it with `PackageHub: Get Started` or from the Package Health view menu.
- The Package Health view explains what to do when no folder is open or the folder has no `.csproj`, `.fsproj` or `.sln` file, with links to open a folder, scan again or get started. It updates when project or solution files are added or removed and when workspace folders change.
- Manifest strings (commands, settings, views, walkthrough) moved to `package.nls.json`, ready for translations.
- A sample solution in `samples/contoso-shop` (four projects, Central Package Management, vulnerable, outdated, deprecated and current packages) and a script in `scripts/screenshots` that captures the README screenshots from a real VS Code window.

### Changed

- Works on VS Code 1.74 and newer, so it installs in Cursor and VSCodium.
- `dotnet` runs with an argument list and no shell. Package ids and versions are checked before any command runs.
- `dotnet` output that cannot be read, and projects `dotnet` reports as errors, are shown as not checked instead of healthy.
- A failed update or restore shows the exit code and the error lines and is never reported as success.
- NuGet version order follows NuGet rules: four-part versions, prerelease labels, build metadata ignored. Ranges, floating versions and properties are not compared. Highest patch never picks a prerelease.
- Project data comes from MSBuild evaluation when the SDK supports it, so `VersionOverride`, the nearest `Directory.Packages.props`, CPM turned on outside the props file, and `GlobalPackageReference` are handled. The file fallback ignores XML comments and reads single quotes, `Update=` and multi-line elements.
- Updates, removes and bulk updates run one at a time. Saving a project file restores and scans once, after a short pause.
- Projects outside any solution are scanned, and projects shared by several solutions are scanned once.
- Warnings follow unsaved edits in open project files.
- The dashboard uses a strict content security policy and checks every message from the page. Hover links can run only PackageHub commands, and only HTTPS advisory links are shown.
- The status bar stays neutral in a folder with no .NET project. Any scan, including the startup scan, sets the `packageHub.scanCompleted` context key, which completes the walkthrough's "Run your first scan" step.
- `project.assets.json` is found when `BaseIntermediateOutputPath`, `MSBuildProjectExtensionsPath` or `UseArtifactsOutput` move it.
- The extension activates only in folders with .NET projects or solutions, and is turned off in untrusted workspaces.
- New README with screenshots of every feature, a quick start, Central Package Management, commands, settings, privacy and FAQ sections. Images use repository paths.
- Planning notes were removed from `docs/`, and `.DS_Store` is ignored.
- `package.json` has `repository`, `homepage`, `bugs` and `author` fields, explicit `capabilities`, and narrower activation events and categories.

### Fixed

- When `dotnet list package --highest-patch` fails ("Sequence contains no matching element"), the highest patch is worked out from the local version list instead of disappearing.
- The deprecated table shows its own empty message.
- Ignoring a package works from `.fsproj` files.
- The remaining Turkish messages are in English.
- Opening the Package Health view in a folder without a `.csproj`, `.fsproj` or `.sln` file no longer starts a scan that ends in an error. The view shows its welcome message instead.

## [0.0.4] - 2026-10-15

### Fixed

- Marketplace README images load from public HTTPS addresses. The five screenshots and language icons are on `https://onurkarakus.com.tr/packagehubfiles/`.

## [0.0.3] - 2026-10-15

### Added

- A package the scan found current shows a check at the end of the line. The check appears only when the installed, vulnerable, outdated, and deprecated lists all include that project. A project the scan could not read stays unmarked.
- F# project files (`.fsproj`) are scanned and get the same line marks, warnings, and actions as C# projects.
- `GlobalPackageReference` lines are recognized, including in `Directory.Packages.props`.

## [0.0.2] - 2026-10-14

### Added

- A package line in an open `.csproj` or `.props` file shows a status mark after a scan. A vulnerable package shows a warning mark, an outdated package shows a cross and the newer version, and a deprecated package shows its own mark. The yellow warning underline stays.

### Fixed

- A solution scan keeps the projects it can read when an old web project cannot import `Microsoft.WebApplication.targets`.
- Projects that still cannot load are named and skipped. The rest of the solution stays in the results.
- On Windows, when Visual Studio is installed, the scan uses that installation's web targets so those projects can be read too.

### Changed

- The Output panel no longer lists every package, project, or scan step. It keeps the scan summary, skipped projects, and failures. Those lines are in English.

## [0.0.1] - 2026-10-13

### Added

- Line warning, hover, lightbulb, and CodeLens for NU1901–NU1904. The default target is the highest patch.
- Latest is the second choice when it is newer. First fixed is read from the advisory range’s exclusive upper bound.
- Package Health tree, Health Dashboard, and a path window for one package.
- Why, Ignore, Remove, and bulk highest-patch and highest-minor updates.
- Health report and vulnerability report copied to the clipboard.
- One scan when a `csproj` or `props` file is saved. Startup scan setting.
- Central Package Management versions are read from `Directory.Packages.props`.

### Changed

- Usage data is not sent. There is no `packageHub.telemetry` setting.
