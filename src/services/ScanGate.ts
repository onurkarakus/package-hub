import { isPackageDocumentPath } from "./projectFiles";

export class ScanGate {
    private running = false;
    private pending = false;

    begin(): boolean {
        if (this.running) {
            this.pending = true;
            return false;
        }
        this.running = true;
        this.pending = false;
        return true;
    }

    end(): boolean {
        if (this.pending) {
            this.pending = false;
            return true;
        }
        this.running = false;
        return false;
    }

    forceIdle(): void {
        this.running = false;
        this.pending = false;
    }
}

export function isPackageProjectFile(filePath: string): boolean {
    return isPackageDocumentPath(filePath);
}
