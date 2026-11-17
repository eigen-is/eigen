import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { LineAttrs, Span } from '@workspace/lib/sheets/ops';
import { LineRuns } from '../../../engine/book/line-runs';
import { below, linesOp, randomOf } from './book-fixtures';

const TALL: LineAttrs = { size: 30, custom: 1 };
const HIDDEN: LineAttrs = { hidden: 1 };
const KEYS = ['size', 'custom', 'hidden'] as const;

describe('engine/book/line-runs — LineRuns', () => {
    test('a list built from a snapshot joins equal neighbours and keeps no line without a key', () => {
        const runs = new LineRuns([
            [[0, 1], TALL],
            [[2, 4], { custom: 1, size: 30 }],
            [[5, 5], {}],
            [[6, 6], TALL],
            [[8, 9], TALL],
            [[10, 10], HIDDEN],
        ]);
        expect(runs.content()).toEqual([
            [[0, 4], TALL],
            [[6, 6], TALL],
            [[8, 9], TALL],
            [[10, 10], HIDDEN],
        ]);
        expect(JSON.stringify(runs.content()[0][1])).toBe('{"size":30,"custom":1}');
    });

    test('a line reads its keys, and none where no run holds it', () => {
        const runs = new LineRuns([
            [[2, 4], TALL],
            [[GRID_ROWS - 1, GRID_ROWS - 1], HIDDEN],
        ]);
        expect([1, 2, 4, 5, GRID_ROWS - 2, GRID_ROWS - 1].map((line) => runs.at(line))).toEqual([
            {},
            TALL,
            TALL,
            {},
            {},
            HIDDEN,
        ]);
        expect(new LineRuns([]).at(0)).toEqual({});
        expect(new LineRuns([]).content()).toEqual([]);
    });

    test('a write sets and clears keys over its spans and returns what every line held', () => {
        const runs = new LineRuns([[[2, 4], TALL]]);
        expect(runs.write([[3, 6]], { hidden: 1 }, ['custom'])).toEqual([
            [[3, 4], TALL],
            [[5, 6], {}],
        ]);
        expect(runs.content()).toEqual([
            [[2, 2], TALL],
            [[3, 4], { size: 30, hidden: 1 }],
            [[5, 6], HIDDEN],
        ]);
    });

    test('a write that clears the last key of a line leaves no run, and joins what became equal', () => {
        const runs = new LineRuns([
            [[0, 1], HIDDEN],
            [[2, 3], TALL],
            [[4, 5], HIDDEN],
        ]);
        runs.write([[2, 3]], { hidden: 1 }, ['size', 'custom']);
        expect(runs.content()).toEqual([[[0, 5], HIDDEN]]);
        runs.write([[0, 5]], {}, ['hidden']);
        expect(runs.content()).toEqual([]);
    });

    test('spans that overlap or come out of order report each line once, with what it held before the write', () => {
        const runs = new LineRuns([[[5, 5], TALL]]);
        const before = runs.write(
            [
                [4, 8],
                [0, 1],
                [6, 9],
                [5, 5],
            ],
            { hidden: 1 },
            [],
        );
        expect(before).toEqual([
            [[0, 1], {}],
            [[4, 4], {}],
            [[5, 5], TALL],
            [[6, 8], {}],
            [[9, 9], {}],
        ]);
        expect(runs.content()).toEqual([
            [[0, 1], HIDDEN],
            [[4, 4], HIDDEN],
            [[5, 5], { ...TALL, hidden: 1 }],
            [[6, 9], HIDDEN],
        ]);
    });

    test('inserted lines hold no key: a run they land in is cut, one they land before moves', () => {
        const runs = new LineRuns([
            [[2, 4], TALL],
            [[8, 8], HIDDEN],
        ]);
        runs.lines(linesOp(true, true, 3, 2));
        expect(runs.content()).toEqual([
            [[2, 2], TALL],
            [[5, 6], TALL],
            [[10, 10], HIDDEN],
        ]);
        runs.lines(linesOp(true, true, 2, 1));
        expect(runs.content()).toEqual([
            [[3, 3], TALL],
            [[6, 7], TALL],
            [[11, 11], HIDDEN],
        ]);
        runs.lines(linesOp(true, true, 12, 5));
        expect(runs.content()[2]).toEqual([[11, 11], HIDDEN]);
    });

    test('a delete returns the keys of its lines where they were and joins what it brings together', () => {
        const runs = new LineRuns([
            [[0, 2], TALL],
            [[3, 5], HIDDEN],
            [[6, 9], TALL],
        ]);
        expect(runs.lines(linesOp(true, false, 2, 5))).toEqual([
            [[2, 2], TALL],
            [[3, 5], HIDDEN],
            [[6, 6], TALL],
        ]);
        expect(runs.content()).toEqual([[[0, 4], TALL]]);
        expect(runs.lines(linesOp(true, false, 5, 3))).toEqual([]);
        expect(runs.lines(linesOp(true, false, 0, 5))).toEqual([[[0, 4], TALL]]);
        expect(runs.content()).toEqual([]);
    });

    test('an insert would push a line off the grid only when that line holds a key', () => {
        const runs = new LineRuns([[[GRID_COLUMNS - 3, GRID_COLUMNS - 3], TALL]]);
        expect(runs.wouldPush(linesOp(false, true, 0, 2))).toBe(false);
        expect(runs.wouldPush(linesOp(false, true, 0, 3))).toBe(true);
        expect(runs.wouldPush(linesOp(true, true, 0, GRID_ROWS - GRID_COLUMNS + 2))).toBe(false);
        expect(runs.wouldPush(linesOp(true, true, 0, GRID_ROWS - GRID_COLUMNS + 3))).toBe(true);
        expect(new LineRuns([]).wouldPush(linesOp(true, true, 0, GRID_ROWS))).toBe(false);
    });
});

// One line's keys per line: what the runs must say, worked out the slow way.
class LinesModel {
    public lines = new Map<number, LineAttrs>();

    public write(spans: readonly Span[], set: LineAttrs, clear: readonly (keyof LineAttrs)[]): void {
        for (const [first, last] of spans) {
            for (let line = first; line <= last; line += 1) {
                const attrs = { ...this.lines.get(line), ...set };
                for (const key of clear) delete attrs[key];
                if (Object.keys(attrs).length > 0) this.lines.set(line, attrs);
                else this.lines.delete(line);
            }
        }
    }

    public shift(index: number, count: number): void {
        const lines = new Map<number, LineAttrs>();
        for (const [line, attrs] of this.lines) {
            if (line < index) lines.set(line, attrs);
            else if (count > 0 || line >= index - count) lines.set(line + count, attrs);
        }
        this.lines = lines;
    }

    public content(): [Span, LineAttrs][] {
        const runs: [[number, number], LineAttrs][] = [];
        for (const line of [...this.lines.keys()].sort((a, b) => a - b)) {
            const attrs = this.lines.get(line) ?? {};
            const end = runs[runs.length - 1];
            if (end && end[0][1] + 1 === line && KEYS.every((key) => end[1][key] === attrs[key])) end[0][1] = line;
            else runs.push([[line, line], attrs]);
        }
        return runs;
    }
}

describe('engine/book/line-runs — the runs are the per-line model’s runs', () => {
    const SETS: LineAttrs[] = [{ size: 30 }, { size: 12.5, custom: 1 }, { hidden: 1 }, { custom: 1 }, {}];
    const LAST = 40;

    for (const seed of [3, 17, 2026]) {
        test(`random writes, inserts and deletes with their inverses, seed ${seed}`, () => {
            const random = randomOf(seed);
            const runs = new LineRuns([]);
            const model = new LinesModel();
            const counts = { write: 0, insert: 0, remove: 0, joined: 0 };
            for (let step = 0; step < 4000; step += 1) {
                const before = runs.content();
                const kind = below(random, 5);
                // Index 0, inside, on the last line that holds a key and past it.
                const index = [0, below(random, LAST), below(random, LAST), LAST, LAST + 5][below(random, 5)];
                const count = 1 + below(random, 4);
                let undo: () => void;
                if (kind < 3) {
                    counts.write += 1;
                    const spans: Span[] = Array.from({ length: 1 + below(random, 3) }, () => {
                        const first = below(random, LAST);
                        return [first, Math.min(LAST, first + below(random, 6))];
                    });
                    const set = SETS[below(random, SETS.length)];
                    const clear = KEYS.filter((key) => !(key in set) && random() < 0.3);
                    const held = new Map(model.lines);
                    const old = runs.write(spans, set, clear);
                    model.write(spans, set, clear);
                    // Each line of the spans once, in order, with the keys the model held.
                    const lines = [
                        ...new Set(spans.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))),
                    ];
                    expect(
                        old.flatMap(([[a, b], attrs]) => Array.from({ length: b - a + 1 }, (_, i) => [a + i, attrs])),
                    ).toEqual(lines.sort((a, b) => a - b).map((line) => [line, held.get(line) ?? {}]));
                    undo = () => {
                        for (const [span, attrs] of old) {
                            runs.write(
                                [span],
                                attrs,
                                KEYS.filter((key) => !(key in attrs)),
                            );
                        }
                    };
                } else if (kind === 3) {
                    counts.insert += 1;
                    expect(runs.lines(linesOp(true, true, index, count))).toEqual([]);
                    model.shift(index, count);
                    undo = () => expect(runs.lines(linesOp(true, false, index, count))).toEqual([]);
                } else {
                    counts.remove += 1;
                    const removed = runs.lines(linesOp(true, false, index, count));
                    model.shift(index, -count);
                    undo = () => {
                        runs.lines(linesOp(true, true, index, count));
                        for (const [span, attrs] of removed) runs.write([span], attrs, []);
                    };
                }
                const content = runs.content();
                expect(content).toEqual(model.content());
                for (const line of [0, index - 1, index, index + count, LAST]) {
                    expect(runs.at(line)).toEqual(model.lines.get(line) ?? {});
                }
                if (content.length < model.lines.size) counts.joined += 1;
                if (step % 3 === 0) {
                    undo();
                    expect(runs.content()).toEqual(before);
                    model.lines = new Map(
                        before.flatMap(([[a, b], attrs]) =>
                            Array.from({ length: b - a + 1 }, (_, i) => [a + i, attrs]),
                        ),
                    );
                }
                // The lines stay near the start: what an insert pushed far away is deleted again.
                const far = runs.content().at(-1)?.[0][1] ?? 0;
                if (far > LAST + 20) {
                    runs.lines(linesOp(true, false, LAST, far));
                    model.shift(LAST, -far);
                }
            }
            expect(counts.write).toBeGreaterThan(1500);
            expect(counts.insert).toBeGreaterThan(500);
            expect(counts.remove).toBeGreaterThan(500);
            expect(counts.joined).toBeGreaterThan(1000);
        });
    }
});
