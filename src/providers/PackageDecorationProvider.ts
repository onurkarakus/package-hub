import * as vscode from "vscode";
import { ScanState } from "../services/ScanState";

export class PackageDecorationProvider {
    private vulnerableDecoration: vscode.TextEditorDecorationType;
    private outdatedDecoration: vscode.TextEditorDecorationType;
    private healthyDecoration: vscode.TextEditorDecorationType;
    private deprecatedDecoration: vscode.TextEditorDecorationType;

    constructor() {
        this.vulnerableDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: " 🔴",
                color: "#f14c4c",
                margin: "0 0 0 8px",
            },
        });

        this.outdatedDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: " 🟠",
                color: "#cca700",
                margin: "0 0 0 8px",
            },
        });

        this.healthyDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: " 🟢",
                color: "#89d185",
                margin: "0 0 0 8px",
            },
        });

        this.deprecatedDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: " ⚪",
                color: "#c586c0",
                margin: "0 0 0 8px",
            },
        });
    }

    updateDecorations() {
        const editors = vscode.window.visibleTextEditors.filter(
            (e) =>
                e.document.fileName.endsWith(".csproj") ||
                e.document.fileName.endsWith(".props")
        );

        for (const editor of editors) {
            this.applyToEditor(editor);
        }
    }

    private applyToEditor(editor: vscode.TextEditor) {
        const vulnarableRanges: vscode.Range[] = [];
        const outdatedRanges: vscode.Range[] = [];
        const healthyRanges: vscode.Range[] = [];
        const deprecatedRanges: vscode.Range[] = [];

        const text = editor.document.getText();
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(/PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/i);

            if (!match) { continue };

            const packageId = match[1];
            const { vulnerable, outdated, deprecated } = ScanState.findPackage(packageId);

            const lineLenght = lines[i].length;
            const range = new vscode.Range(i, lineLenght, i, lineLenght);

            if (vulnerable) {
                vulnarableRanges.push(range);
            } else if (deprecated) {
                deprecatedRanges.push(range);
            } else if (outdated) {
                outdatedRanges.push(range);
            } else if (
                ScanState.getVulnerable().length > 0 ||
                ScanState.getOutDated().length > 0 ||
                ScanState.getDeprecated().length > 0
            ) {
                healthyRanges.push(range);
            }
        }

        editor.setDecorations(this.vulnerableDecoration, vulnarableRanges);
        editor.setDecorations(this.outdatedDecoration, outdatedRanges);
        editor.setDecorations(this.healthyDecoration, healthyRanges);
        editor.setDecorations(this.deprecatedDecoration, deprecatedRanges);
    }

    dispose() {
        this.vulnerableDecoration.dispose();
        this.outdatedDecoration.dispose();
        this.healthyDecoration.dispose();
        this.deprecatedDecoration.dispose();
    }
}