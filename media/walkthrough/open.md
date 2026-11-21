# Open a .NET project or solution

PackageHub starts on its own when the folder contains one of these files:

| File | What PackageHub reads |
| --- | --- |
| `.csproj` | C# project packages |
| `.fsproj` | F# project packages |
| `.vbproj` | Visual Basic project packages |
| `.sln` / `.slnx` | Every project in the solution |
| `Directory.Packages.props` | Central package versions |

**You need**

- `dotnet` on your PATH
- The .NET SDK 8.0.400 or newer for **Why is this here?**
- The .NET SDK 8.0.200 or newer to search package sources from **Add Package**

**Tip:** open the folder that holds your `.sln` or `.slnx` file, so one scan covers the whole solution.
