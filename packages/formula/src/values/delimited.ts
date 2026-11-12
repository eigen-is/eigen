// The part of a text before or after one of its delimiters, as TEXTBEFORE and TEXTAFTER cut it. Delimiters are
// counted from the start of the text, or from its end for a negative instance, and never overlap. The search runs
// on `key`, the text itself or its upper-cased form of the same length, and the cut is made in `text`.

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
    let start = forward ? 0 : key.length;
    let end = start;
    for (let found = 1; found <= wanted; found += 1) {
        const from = forward ? end : start;
        let next = -1;
        let length = 0;
        for (const delimiter of delimiters) {
            if (!forward && delimiter.length > from) continue;
            const at = forward ? key.indexOf(delimiter, from) : key.lastIndexOf(delimiter, from - delimiter.length);
            if (at < 0 || (next >= 0 && (forward ? at >= next : at + delimiter.length <= next + length))) continue;
            next = at;
            length = delimiter.length;
        }
        if (next < 0) {
            if (!toEnd || found < wanted) return undefined;
            next = forward ? key.length : 0;
        }
        start = next;
        end = next + length;
    }
    return after ? text.slice(end) : text.slice(0, start);
}
