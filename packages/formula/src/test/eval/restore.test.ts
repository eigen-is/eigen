import { expect, test } from 'bun:test';
import type { RecalcResult } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, valueAt } from '../recalc/support';

// Nothing in the engine throws by itself, so the test runs it where the stack is nearly used up: a recalc that
// is started there overflows somewhere inside a formula.
test('a recalc that threw leaves the engine as a recalc that never ran', () => {
    const cells: Record<string, string | number> = { A300: 1, B1: '=SUM(A1:A300)', B2: '=SUM(IF(A1:A3>0,A1:A3))' };
    for (let row = 1; row < 300; row += 1) cells[`A${row}`] = `=IF(TRUE,A${row + 1}+1)`;
    const typed: Cells = cells;
    const engine = engineOf({ s1: typed });
    let thrown = 0;
    // Down to the end of the stack, then a recalc at every level on the way back up until one has the room.
    const dive = (): RecalcResult => {
        try {
            return dive();
        } catch {
            thrown += 1;
            return engine.recalc(Number.POSITIVE_INFINITY);
        }
    };
    expect(dive()).toEqual({ loops: [], stopped: false });
    expect(thrown).toBeGreaterThan(3);
    expect(valueAt(engine, 'A1')).toBe(300);
    expect(valueAt(engine, 'B1')).toBe((300 * 301) / 2);
    expect(valueAt(engine, 'B2')).toBe(300 + 299 + 298);
});
