# Open a .NET project or solution

PackageHub starts on its own when the folder contains one of these files:

| File | What PackageHub reads |
| --- | --- |
| `.csproj` | C# project packages |
| `.fsproj` | F# project packages |
| `.sln` | Every project in the solution |
| `Directory.Packages.props` | Central package versions |

`.slnx` files are skipped.

**You need**

- `dotnet` on your PATH
- The .NET SDK 8.0.400 or newer for **Why is this here?**

**Tip:** open the folder that holds your `.sln` file, so one scan covers the whole solution.
