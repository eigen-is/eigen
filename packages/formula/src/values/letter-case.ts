// Upper case as Excel maps it: character by character, so a letter whose upper case is two letters stays as it
// is and a text keeps its length. UPPER("straße") is STRAßE.

export function upperCase(text: string): string {
    const upper = text.toUpperCase();
    if (upper.length === text.length) return upper;
    let mapped = '';
    for (const letter of text) {
        const one = letter.toUpperCase();
        mapped += one.length === letter.length ? one : letter;
    }
    return mapped;
}
