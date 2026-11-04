# PackageHub

**Manage your NuGet packages inside the editor.** PackageHub reads your C# and F# projects, shows which packages need attention, and keeps the safe update one click away.

You do not have to hunt through project files and yellow warnings. Open the project, let the scan finish, and the package line tells you where things stand. Nothing changes until you choose **Yes, Update**.

![Package lines after a scan. A vulnerable package shows a warning and the newer version, an outdated package shows a cross and the newer version, and a current package shows a check.](https://onurkarakus.com.tr/packagehubfiles/package-lines.png)

## What you can do

- **See the status on the line.** After a scan, a package line shows one mark. A vulnerable package shows a warning, an outdated package shows a cross and the newer version, and a deprecated package shows its own mark. A package the scan found current shows a check.
- **Keep the yellow warning.** The NU1901–NU1904 underline, the lightbulb, and the text above the line stay. The mark does not replace them.
- **Put the safe update first.** The first suggestion is the highest patch in the same major. A newer major is a separate choice.
- **Work from one list.** Vulnerable, outdated, and deprecated packages sit in the side bar and in the health dashboard.
- **See the path.** A separate window shows which project brought the package in.
- **Stay in control.** Project files are not written until you confirm. Usage data never leaves this machine.

## Languages and files

<p>
  <img src="https://onurkarakus.com.tr/packagehubfiles/csharp.png" alt="C#" width="48" height="48" />
  &nbsp;&nbsp;<strong>C#</strong>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="https://onurkarakus.com.tr/packagehubfiles/fsharp.png" alt="F#" width="48" height="48" />
  &nbsp;&nbsp;<strong>F#</strong>
</p>

PackageHub reads .NET projects:

- C# project files (`.csproj`)
- F# project files (`.fsproj`)
- Visual Studio solutions (`.sln`)
- Central package versions in `Directory.Packages.props`
- `GlobalPackageReference` when the package and its version are on the same line

`.slnx` files are skipped.

## The mark on the package line

The mark appears after a scan, at the end of the package line.

- **Warning.** The package is vulnerable. When a newer version exists, it is written next to the warning.
- **Cross.** The package is outdated. The version next to the cross is the latest version. The same-major patch stays in the text above the line.
- **Deprecated.** The package is deprecated. A newer version is shown when one exists.
- **Check.** The scan read that project and the package is not vulnerable, outdated, or deprecated.

A check is drawn only when the installed, vulnerable, outdated, and deprecated lists all include that project. A project the scan could not read stays unmarked. If one of those lists fails, that project gets no check. The mark is not clickable, and moving the cursor over it does not run `dotnet`.

The line above a vulnerable package still offers the highest patch in one click.

## Update a package

1. Open a folder that contains a `.csproj`, `.fsproj`, `.sln`, or `.props` file. PackageHub starts on its own.
2. Wait for the startup scan, or run `PackageHub: Scan Workspace`. Saving a `.csproj`, `.fsproj`, or `.props` file starts a scan too.
3. Hover the yellow line. It shows the version and whether the advisory is still open. Opening that hover does not run `dotnet`.
4. Open the lightbulb. The first item is **Update to highest patch**. **Update to latest** appears under it when a newer version exists. **Open Advisory** appears when a link exists. The first version that closes the advisory can appear further down. It is not the default.
5. Confirm the choice. The button says **Yes, Update**. PackageHub then updates the package, restores, and scans again.

![Quick Fix on a vulnerable package. The highest patch is the first choice. Latest and the first fixed version are listed under it.](https://onurkarakus.com.tr/packagehubfiles/quick-fix.png)

With Central Package Management, the version is written to `Directory.Packages.props`. You do not edit the project file by hand.

## Your package list

The **PackageHub** icon on the Activity Bar opens your packages.

![Package Health after a scan. Vulnerable and outdated packages are listed, with the project that contains them.](https://onurkarakus.com.tr/packagehubfiles/package-list.png)

`PackageHub: Show Health Dashboard` shows how many need attention and offers the bulk updates.

The bulk buttons are **Highest patch** and **Highest minor**. **Update to latest** on a row updates only that package.

The status bar counts vulnerable, outdated, and deprecated packages.

## Why is this package here?

Choose **Why is this here?** from the hover or from the line’s right-click menu. The path opens in its own window. The command output is written to the Output panel. This needs the .NET SDK 8.0.400 or newer.

## Hide or remove

**Ignore** hides the package from PackageHub lists only. The build warning stays.

**Remove** takes the package out of the project after you confirm. You do not delete the line by hand.

## Commands you will use

| Command | What it does |
| --- | --- |
| `PackageHub: Scan Workspace` | Scans your packages again |
| `PackageHub: Show Health Dashboard` | Opens the summary and the bulk updates |
| `PackageHub: Why is this here?` | Shows how the package entered the project |
| `PackageHub: Copy Health Report` | Copies the health summary to the clipboard |
| `PackageHub: Copy Vulnerability Report` | Copies the vulnerability list to the clipboard |
| `PackageHub: Update All to Highest Patch` | Applies the same-major patch across packages |
| `PackageHub: Update All to Highest Minor` | Applies the same-major minor update across packages |

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `packageHub.scanOnStartup` | Scans your packages when the folder opens | `true` |
| `packageHub.includePrerelease` | Adds prereleases to the next outdated list. The vulnerability scan stays the same | `false` |
| `packageHub.minimumSeverity` | Lowest severity PackageHub lists. It does not change `NuGetAuditLevel` in the project | `low` |
| `packageHub.minimumReleaseAge` | How many days old a latest version must be. `0` is off. The highest-patch suggestion ignores this. Publish dates come from the local NuGet cache | `0` |
| `packageHub.dashboardViewMode` | Dashboard layout: `list`, `byProject`, or `byPackage` | `list` |
| `packageHub.ignoredPackages` | Package ids hidden from the lists | `[]` |
| `packageHub.onlineLookups` | Lets PackageHub ask nuget.org itself for advisory ranges and publish dates that are not in the local cache | `false` |
| `packageHub.timeouts.listSeconds` | Timeout for `dotnet list package` and other quick commands | `120` |
| `packageHub.timeouts.outdatedSeconds` | Timeout for the outdated and deprecated lists | `300` |
| `packageHub.timeouts.restoreSeconds` | Timeout for `dotnet restore` and `dotnet add package` | `600` |
| `packageHub.maxDotnetProcesses` | How many `dotnet` processes run at the same time | `4` |

## Requirements

- VS Code 1.74 or newer, or a compatible editor such as Cursor or VSCodium
- `dotnet` on your PATH
- .NET SDK 8.0.400 or newer for Why

## Privacy

PackageHub is local-first. With the default settings the extension itself makes no network request and collects no usage data.

- All package data comes from the `dotnet` CLI on your machine and from local files: your project files, `project.assets.json`, and the NuGet caches `dotnet` already wrote.
- `dotnet` itself contacts the package sources in your NuGet.config when it restores, lists outdated or vulnerable packages, or adds a package. That is the same traffic as running those commands yourself. PackageHub runs them with `DOTNET_CLI_TELEMETRY_OPTOUT=1`.
- Only when you turn on `packageHub.onlineLookups` does PackageHub contact `api.nuget.org` over HTTPS itself: for advisory version ranges and for publish dates used by `packageHub.minimumReleaseAge`, when they are not in the local NuGet cache. With it off, a missing publish date is reported as unknown and the age gate is not applied.
- Opening a NuGet or advisory page only happens when you click it, in your browser.

## Feedback

Use the Q&A section on the Marketplace page for questions and requests.

## License

MIT
