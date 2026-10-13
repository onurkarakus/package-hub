# PackageHub

**Manage your NuGet packages inside the editor.** See which packages need attention, update them with less effort, and answer “why is this package here?” in one place.

You do not have to hunt through project files and yellow warnings. PackageHub lists your packages, puts the safe update first, and turns the job into a few clicks. Nothing changes until you choose **Yes, Update**.

## What it helps with

- **Your packages, in one list.** Vulnerable, outdated, and deprecated packages sit in the side bar.
- **The yellow warning becomes readable.** Hover the line and you see why it was flagged, plus the version.
- **Updates stay easy.** The first suggestion is the highest patch in the same major. A newer major is a separate choice.
- **Bulk work on one screen.** Apply a patch or minor update to many packages from the dashboard.
- **You can see the path.** A separate window shows which project brought the package in.
- **You stay in control.** Project files are not written until you confirm. Usage data never leaves this machine.

## Install

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for PackageHub.
3. Click Install.

After install, the **PackageHub** icon sits on the Activity Bar. Open the Command Palette with `Ctrl+Shift+P` / `Cmd+Shift+P`.

## Update a package

1. Open a folder that contains a `.csproj`, `.sln`, or `.props` file. PackageHub starts on its own.
2. Wait for the startup scan. You can also run `PackageHub: Scan Workspace`. Saving a `csproj` or `props` file starts a scan too.
3. Hover the yellow line. It shows the version and whether the advisory is still open. Opening that hover does not run `dotnet`.
4. Open the lightbulb. The first item is **Update to highest patch**, the highest patch in the same major. **Update to latest** appears under it when a newer version exists. **Open Advisory** appears when a link exists. The first version that closes the advisory can appear further down. It is not the default.
5. Confirm the choice. The button says **Yes, Update**. PackageHub then updates the package, restores, and scans again.

The text above the line applies that same patch in one click.

With Central Package Management, the version is written to `Directory.Packages.props`. You do not edit the project file by hand.

## Your package list

The **PackageHub** icon on the Activity Bar opens your packages. `PackageHub: Show Health Dashboard` shows how many need attention and offers the bulk updates.

The bulk buttons are **Highest patch** and **Highest minor**. **Update to latest** on a row updates only that package.

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
| `packageHub.minimumReleaseAge` | How many days old a latest version must be. `0` is off. The highest-patch suggestion ignores this | `0` |
| `packageHub.dashboardViewMode` | Dashboard layout: `list`, `byProject`, or `byPackage` | `list` |
| `packageHub.ignoredPackages` | Package ids hidden from the lists | `[]` |

## Privacy

Scanning, updating, and the path lookup stay on this machine. PackageHub does not collect or send usage data.

## Requirements

- VS Code 1.125.0 or newer
- `dotnet` on your PATH
- .NET SDK 8.0.400 or newer for Why

## Feedback

Use the Q&A section on the Marketplace page for questions and requests.

## License

MIT
