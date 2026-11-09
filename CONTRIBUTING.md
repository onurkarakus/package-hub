# Contributing

Thanks for taking a look. Bug reports and pull requests are welcome in [GitHub issues](https://github.com/onurkarakus/package-hub/issues).

## Setup

You need Node.js 20 or newer, the .NET SDK 8.0.400 or newer on your PATH, and VS Code.

```sh
git clone https://github.com/onurkarakus/package-hub.git
cd package-hub
npm ci
npm run compile
```

## Run the extension

Open the folder in VS Code and press **F5**. The launch configurations start an Extension Development Host, optionally with one of the samples in `samples/` open:

- `samples/audit-quickfix`: a small C# project with a vulnerable package
- `samples/fsharp-audit`: the same for F#
- `samples/contoso-shop`: a four-project solution with Central Package Management, used for the screenshots

### "Cannot find module …/dist/extension.js"

The extension runs from the bundle in `dist/`, which is not in the repository. If the Development Host reports that `dist/extension.js` is missing, build it once with `npm run compile`, or start `npm run watch` in a terminal, then press **F5** again.

## Checks

```sh
npm run pretest            # types, lint and the bundle
xvfb-run -a npm test       # tests on the current VS Code
xvfb-run -a npm run test:min   # tests on VS Code 1.74, the oldest supported
```

Drop `xvfb-run -a` on a machine with a display.

## Ground rules

- PackageHub is local-first. It must not make a network request of its own unless `packageHub.onlineLookups` is on, and that goes through `src/services/OnlineFetch.ts` only.
- Nothing is written to a project file without a confirmation.
- Webviews keep the nonce-based Content Security Policy: no inline scripts, styles or event handlers.
- Keep `engines.vscode` at `^1.74.0` unless there is a strong reason, and run `npm run test:min` before a pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## Screenshots

`scripts/screenshots/capture.cjs` captures the README images from a real VS Code window. The header of that file lists what it needs and how to run it.

## Releases

See [PUBLISHING.md](PUBLISHING.md).
