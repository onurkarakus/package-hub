import { PackageInfo } from "./PackageInfo";

export interface ProjectInfo {
    path: string;
    name: string;
    packages: PackageInfo[];
}