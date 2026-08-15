import * as vscode from "vscode";

/**
 * PackageHub için merkezi log kanalı.
 * View → Output → “PackageHub” seçerek görebilirsin.
 */
export const logger = vscode.window.createOutputChannel("PackageHub", {
    log: true,
});