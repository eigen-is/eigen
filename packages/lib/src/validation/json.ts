// Checks for JSON that a file or the browser hands back, such as a backup's records or the data epochs a tab keeps. A
// parse that fails reads as undefined, which every check refuses, and each check narrows the value without a cast.

// Undefined for text that is not JSON, which every check refuses.
export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === 'string')
    );
}

// A JSON object of strings, as the data-epoch maps are kept on the server and in a tab; null for anything else.
export function parseStringRecord(text: string): Record<string, string> | null {
    const value = parseJson(text);
    return isStringRecord(value) ? value : null;
}
