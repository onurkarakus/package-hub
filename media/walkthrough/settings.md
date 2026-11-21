# Tune what you see

The defaults work for most projects. These three change what PackageHub lists:

| Setting | Default | What it does |
| --- | --- | --- |
| `packageHub.minimumSeverity` | `low` | Lowest severity PackageHub reports: `low`, `moderate`, `high` or `critical`. It does not change `NuGetAuditLevel` in your project. |
| `packageHub.includePrerelease` | `false` | Adds prereleases to the next outdated list. The vulnerability scan stays the same. |
| `packageHub.minimumReleaseAge` | `0` | How many days old a latest version must be before it is preferred. `0` is off. The highest-patch suggestion ignores this. |

Other settings:

- `packageHub.scanOnStartup` scans when the folder opens (`true`).
- `packageHub.ignoredPackages` hides package ids from the lists. **Ignore** on a package adds it for you.
- `packageHub.badge` sets what the view badge counts: `vulnerable` (default), `vulnerableAndOutdated`, `all` or `off`.
- `packageHub.rollbackOnFailure` puts every file back when one step of a bulk update fails (`true`).
- `packageHub.onlineLookups` lets PackageHub read missing advisory ranges, publish dates and package metadata from nuget.org (`false`).
