# Changelog

## [0.1.0] - 2026-11-05

### Added

- Local-first by default: PackageHub makes no network request of its own. Advisory ranges and publish dates are read from the NuGet cache `dotnet` already wrote. The new `packageHub.onlineLookups` setting (off by default) allows asking nuget.org when local data is missing.
- Feed health: the tree and the dashboard list the NuGet sources `dotnet` uses, whether each is enabled, which ones failed in the last scan or restore (NU1301, NU1302, NU1801, NU1900, NU1905), and credential provider hints.
- An update summary before every update: from and to versions, patch/minor/major, advisories closed or still open, direct or transitive, affected projects, whether a CPM file is edited, and prerelease and age warnings.
- Pinning a transitive package asks for its own confirmation.
- Version conflicts are found per project and target framework.
- Settings for `dotnet` timeouts and for how many `dotnet` processes run at once.
- `npm run test:min` runs the tests on the oldest supported VS Code. `npm run publish:ovsx` and PUBLISHING.md for Open VSX.

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
- The status bar stays neutral in a folder with no .NET project, and the scan sets the `packageHub.scanCompleted` context key.
- `project.assets.json` is found when `BaseIntermediateOutputPath`, `MSBuildProjectExtensionsPath` or `UseArtifactsOutput` move it.
- The extension activates only in folders with .NET projects, and is turned off in untrusted workspaces.

### Fixed

- When `dotnet list package --highest-patch` fails ("Sequence contains no matching element"), the highest patch is worked out from the local version list instead of disappearing.
- The deprecated table shows its own empty message.
- Ignoring a package works from `.fsproj` files.
- The remaining Turkish messages are in English.

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
