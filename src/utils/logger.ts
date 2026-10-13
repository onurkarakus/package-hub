import * as vscode from "vscode";

/**
 * Central log channel for PackageHub.
 * View → Output → select “PackageHub”.
 */
export const logger = vscode.window.createOutputChannel("PackageHub", {
    log: true,
});