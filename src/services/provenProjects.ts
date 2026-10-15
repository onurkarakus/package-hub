export function provenProjectNames(groups: string[][]): string[] {
    if (groups.length === 0 || groups.some((group) => group.length === 0)) {
        return [];
    }

    const [first, ...rest] = groups;
    const seen = new Set<string>();
    const names: string[] = [];

    for (const name of first) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        const inEveryList = rest.every((group) =>
            group.some((item) => item.toLowerCase() === key)
        );
        if (!inEveryList) {
            continue;
        }

        seen.add(key);
        names.push(name);
    }

    return names;
}
