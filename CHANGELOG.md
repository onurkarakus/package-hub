# Changelog

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
