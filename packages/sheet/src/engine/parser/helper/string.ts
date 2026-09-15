export function trimEdges(string: string, margin = 1): string {
    return string.substring(margin, string.length - margin);
}
