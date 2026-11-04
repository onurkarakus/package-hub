# Contoso Shop sample

A small .NET 8 solution used to try PackageHub and to capture the README screenshots
(`scripts/screenshots/capture.cjs`).

- `src/Shop.Api` (web), `src/Shop.Core`, `src/Shop.Data` and `tests/Shop.Tests`
- Central Package Management in `Directory.Packages.props`
- Vulnerable packages: `Newtonsoft.Json` 12.0.1, `System.Text.Json` 8.0.0, `Microsoft.Data.SqlClient` 5.1.0 (and the transitive packages they bring in)
- Deprecated: `Microsoft.Azure.ServiceBus` 5.2.0
- Outdated: `Serilog.AspNetCore`, `Swashbuckle.AspNetCore`, `Polly`, `Moq`
- Current at the time of writing: `Dapper`, `FluentValidation`, `Humanizer.Core`, `Microsoft.NET.Test.Sdk`

The versions are old on purpose. Do not use them in a real project.
