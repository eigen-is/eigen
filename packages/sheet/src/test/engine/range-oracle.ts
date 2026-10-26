// The cell-membership reading of Excel's rule: every row of a range lands where the insert or
// delete moves it, and the range spans what survives. Every range-carrying feature (CF,
// alternate formats and charts) must agree with it on every small case.
export type Span = [number, number];
export const SPANS: Span[] = [];
for (let a = 0; a <= 5; a += 1) for (let b = a; b <= 5; b += 1) SPANS.push([a, b]);

export function expectedInsert([a, b]: Span, insertAt: number, count: number): Span {
    const at = (r: number) => (r < insertAt ? r : r + count);
    return [at(a), at(b)];
}

export function expectedDelete([a, b]: Span, start: number, end: number): Span | null {
    const kept: number[] = [];
    for (let r = a; r <= b; r += 1) {
        if (r < start) kept.push(r);
        else if (r > end) kept.push(r - (end - start + 1));
    }
    return kept.length > 0 ? [kept[0], kept[kept.length - 1]] : null;
}
