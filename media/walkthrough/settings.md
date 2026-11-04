# Tune what you see

The defaults work for most projects. These three change what PackageHub lists:

| Setting | Default | What it does |
| --- | --- | --- |
| `packageHub.minimumSeverity` | `low` | Lowest severity PackageHub reports: `low`, `moderate`, `high` or `critical`. It does not change `NuGetAuditLevel` in your project. |
| `packageHub.includePrerelease` | `false` | Adds prereleases to the next outdated list. The vulnerability scan stays the same. |
| `packageHub.minimumReleaseAge` | `0` | How many days old a latest version must be before it is preferred. `0` is off. The highest-patch suggestion ignores this. |

Other settings:

- `packageHub.scanOnStartup` scans when the folder opens (`true`).
- `packageHub.dashboardViewMode` sets the dashboard layout: `list`, `byProject` or `byPackage`.
- `packageHub.ignoredPackages` hides package ids from the lists. **Ignore** on a package adds it for you.
