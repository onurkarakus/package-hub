# Changelog

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
