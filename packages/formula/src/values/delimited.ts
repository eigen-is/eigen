// The part of a text before or after one of its delimiters, as TEXTBEFORE and TEXTAFTER cut it. Delimiters are
// counted from the start of the text, or from its end for a negative instance, and never overlap. The search runs
// on `key`, the text itself or its upper-cased form of the same length, and the cut is made in `text`.

import { countCharacters, cutCharacters, findCharacters, findLastCharacters } from './characters';

// Undefined when the text holds fewer delimiters than `instance` asks. With `toEnd`, the end of the text the
// search runs toward counts as one more delimiter.
export function partBeside(
    text: string,
    key: string,
    delimiters: readonly string[],
    instance: number,
    toEnd: boolean,
    after: boolean,
): string | undefined {
    const forward = instance > 0;
    const wanted = Math.abs(instance);
    const length = countCharacters(key);
    // The characters in front of the delimiter found last, and those up to its end.
    let start = forward ? 0 : length;
    let end = start;
    for (let found = 1; found <= wanted; found += 1) {
        const from = forward ? end : start;
        let next = -1;
        let size = 0;
        for (const delimiter of delimiters) {
            const width = countCharacters(delimiter);
            if (!forward && width > from) continue;
            const at = forward
                ? findCharacters(delimiter, key, from + 1) - 1
                : findLastCharacters(delimiter, key, from - width + 1) - 1;
            if (at < 0 || (next >= 0 && (forward ? at >= next : at + width <= next + size))) continue;
            next = at;
            size = width;
        }
        if (next < 0) {
            if (!toEnd || found < wanted) return undefined;
            next = forward ? length : 0;
        }
        start = next;
        end = next + size;
    }
    return after ? cutCharacters(text, end, length) : cutCharacters(text, 0, start);
}
