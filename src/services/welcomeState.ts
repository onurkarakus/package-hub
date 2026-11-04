export type WelcomeState = "noFolder" | "noProjects" | undefined;

/**
 * Which welcome message the Package Health view shows.
 * Undefined means the view has something to list.
 */
export function welcomeState(folderCount: number, projectCount: number): WelcomeState {
    if (folderCount <= 0) {
        return "noFolder";
    }
    if (projectCount <= 0) {
        return "noProjects";
    }
    return undefined;
}
