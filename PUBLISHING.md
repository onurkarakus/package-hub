# Publishing

PackageHub is published to the Visual Studio Marketplace and to Open VSX (used by VSCodium, Cursor, Gitpod and others). Nothing here runs automatically.

## Before a release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. `npm ci`
3. `npm run pretest` (types, lint, build)
4. `xvfb-run -a npm test` (current VS Code) and `xvfb-run -a npm run test:min` (the oldest VS Code in `engines.vscode`). Drop `xvfb-run -a` on a machine with a display.
5. `npm run package:vsix` builds `package-hub-<version>.vsix`. Install it once by hand and check a scan.

## Visual Studio Marketplace

```sh
npx --yes @vscode/vsce login onurkarakus
npx --yes @vscode/vsce publish --packagePath package-hub-<version>.vsix
```

## Open VSX

1. Sign in at https://open-vsx.org with GitHub and sign the publisher agreement.
2. Create an access token in your Open VSX profile settings.
3. The first time only, create the namespace:

   ```sh
   npx --yes ovsx create-namespace onurkarakus -p <token>
   ```

4. Publish the same `.vsix` that went to the Marketplace:

   ```sh
   npm run publish:ovsx -- package-hub-<version>.vsix -p <token>
   ```

   Or set `OVSX_PAT` in the environment and leave out `-p`.

Keep tokens out of the repository and out of shell history (for example `read -s OVSX_PAT; export OVSX_PAT`).

## Compatibility

`engines.vscode` is `^1.74.0`. `@types/vscode` is pinned to the same minor so the code cannot use a newer API by accident. Raise both together, and run `npm run test:min` after.
