export function isProjectLoadFailure(message: string): boolean {
    if (message.includes("`dotnet` was not found")) {
        return false;
    }

    return /the imported project|error MSB\d+|NETSDK\d+/i.test(message);
}

export function projectLoadSummary(message: string): string {
    const imported = message.match(/The imported project "([^"]+)" was not found/i);
    if (imported) {
        const file = imported[1].split(/[/\\]/).pop();
        return `dotnet could not find ${file}.`;
    }

    const errorLine = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^error:/i.test(line));
    if (errorLine) {
        return errorLine.replace(/^error:\s*/i, "").slice(0, 180);
    }

    return "dotnet could not load this project.";
}
