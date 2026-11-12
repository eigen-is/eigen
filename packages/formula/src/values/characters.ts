// What a character is to every function that counts, cuts or finds by position, such as LEN, MID and FIND: one
// UTF-16 code unit, so an emoji is two characters where Excel on the web counts one. That choice lives here and
// nowhere else: a function or kernel that measures a text, cuts it, finds a place in it or asks for its first code
// does it through these, and their positions count from 1.

import { upperCase } from './letter-case';
import { patternStart } from './wildcard';

export function countCharacters(text: string): number {
    return text.length;
}

// The `count` characters after the first `skipped`.
export function cutCharacters(text: string, skipped: number, count: number): string {
    return text.slice(skipped, skipped + count);
}

// The position of `sought` at or after `start`, and 0 when it is not there.
export function findCharacters(sought: string, text: string, start: number): number {
    return text.indexOf(sought, start - 1) + 1;
}

// The last position of `sought` at or before `start`, which is 1 or more, and 0 when it is not there.
export function findLastCharacters(sought: string, text: string, start: number): number {
    return text.lastIndexOf(sought, start - 1) + 1;
}

// As findCharacters, with wildcards in `sought` and no regard to case.
export function searchCharacters(sought: string, text: string, start: number): number {
    return patternStart(upperCase(sought), upperCase(text), start - 1) + 1;
}

// The Unicode code point the text starts with, and undefined for an empty text. Both halves of a pair are read
// here, as UNICODE reads them, though they count as two characters.
export function firstCode(text: string): number | undefined {
    return text.codePointAt(0);
}
