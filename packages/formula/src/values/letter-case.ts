// Letter case as Excel maps it: character by character, so a text keeps its length. A letter whose upper case is
// two letters stays as it is, so UPPER("straße") is STRAßE, and the one letter whose lower case is two characters,
// the dotted capital I, becomes a plain i.

const LETTER = /\p{L}/u;

// An accent written as a character of its own belongs to the letter in front of it.
const MARK = /\p{M}/u;

const DOTTED_CAPITAL_I = /\u0130/g;

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

// The host lowers a capital sigma to its final form at the end of a word, as Excel does.
export function lowerCase(text: string): string {
    return text.replace(DOTTED_CAPITAL_I, 'i').toLowerCase();
}

// A capital for every letter that follows something that is no letter, lower case for the rest.
export function properCase(text: string): string {
    let proper = '';
    let inWord = false;
    for (const letter of lowerCase(text)) {
        const isLetter = LETTER.test(letter);
        proper += isLetter && !inWord ? upperCase(letter) : letter;
        if (!MARK.test(letter)) inWord = isLetter;
    }
    return proper;
}
