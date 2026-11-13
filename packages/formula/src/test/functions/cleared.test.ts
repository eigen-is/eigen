import { expect, test } from 'bun:test';
import type { Literal } from '../../index';
import type { Cells } from '../recalc/support';
import { at, engineOf, valueAt } from '../recalc/support';
import { random } from '../store/support';

// What a function computes depends on the cells and never on how long a column once was: after writes and clears,
// of the last cells of a column most of all, every lookup and criterion equals what a fresh load computes.

const FORMULAS: readonly string[] = [
    '=VLOOKUP(G1,A2:B11,1,TRUE)',
    '=VLOOKUP(G1,A2:B11,2,TRUE)',
    '=VLOOKUP(G1,A2:B11,2,FALSE)',
    '=VLOOKUP(G1,A:B,2)',
    '=HLOOKUP(G1,I1:R2,2,TRUE)',
    '=HLOOKUP(G1,I1:R2,1,FALSE)',
    '=HLOOKUP(G1,1:2,2)',
    '=LOOKUP(G1,A2:A11)',
    '=LOOKUP(G1,A2:A11,B2:B11)',
    '=LOOKUP(G1,I1:R1,I2:R2)',
    '=MATCH(G1,A2:A11,1)',
    '=MATCH(G1,A2:A11,0)',
    '=MATCH(G1,A2:A11,-1)',
    '=MATCH(G1,A:A)',
    '=MATCH(G1,I1:R1,1)',
    '=MATCH(G1,A2:A11*1,1)',
    '=MATCH(G1,A2:A11&"",0)',
    '=MATCH(G1,I1:R1*1,-1)',
    '=XMATCH(G1,A2:A11,0,1)',
    '=XMATCH(G1,A2:A11,0,-1)',
    '=XMATCH(G1,A2:A11,-1,1)',
    '=XMATCH(G1,A2:A11,1,-1)',
    '=XMATCH(G1,A2:A11,-1,2)',
    '=XMATCH(G1,A2:A11,1,-2)',
    '=XMATCH(G1,A2:A11,0,2)',
    '=XMATCH(G4,A2:A11)',
    '=XMATCH(G4,A2:A11,0,-1)',
    '=XMATCH(G1,A:A,1,-1)',
    '=XMATCH(G1,I1:R1,-1,-1)',
    '=XMATCH(G1,A2:A11*1,1,-1)',
    '=XLOOKUP(G1,A2:A11,B2:B11,"none",-1,2)',
    '=XLOOKUP(G1,A2:A11,B2:B11,"none",1,-1)',
    '=XLOOKUP(G1,I1:R1,I2:R2,"none",-1)',
    '=COUNTIF(A2:A11,"")',
    '=COUNTIF(A2:A11,"<>")',
    '=COUNTIF(A2:A11,"<>3")',
    '=COUNTIF(A:A,"<5")',
    '=COUNTIF(A2:B11,G1)',
    '=COUNTIFS(A2:A11,"",B2:B11,"")',
    '=COUNTIFS(A2:A11,"<>x",B2:B11,">1")',
    '=SUMIF(A2:A11,">2",B2:B11)',
    '=SUMIF(A2:A11,"",B2:B11)',
    '=SUMIF(A2:A11,"<>3",B2)',
    '=SUMIFS(B:B,A:A,"<>3")',
    '=AVERAGEIF(A2:A11,"<>",B2:B11)',
    '=MAXIFS(B2:B11,A2:A11,"")',
    '=MINIFS(B2:B11,A2:A11,"<>x")',
    '=COUNTBLANK(A2:B11)',
    '=COUNTA(A:B)',
    '=COUNT(1:2)',
    '=SUMPRODUCT(--(A2:A11=""))',
    '=SUMPRODUCT(A2:A11,B2:B11)',
    '=SUM((A:A="")*1)',
    '=INDEX(A2:A11*B2:B5,3)',
    '=INDEX(A2:A11*B2:B5,7)',
    '=INDEX(A2:A5&B2:B11,4)',
    '=INDEX(A2:A5&B2:B11,9)',
    '=INDEX(I1:R1+I2:L2,1,3)',
    '=INDEX(I1:R1+I2:L2,1,8)',
    '=SUM(A2:A11*B2:B5)',
    '=COUNT(A2:A11*B2:B11)',
    '=MAX(A:A*1)',
    '=AND(A2:A11="")',
];

const HOSTS = FORMULAS.map((_, i) => `T${i + 1}`);

function run(seed: number): number {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const model = new Map<string, Literal>();
    const formulas: Record<string, Literal> = {};
    for (let i = 0; i < FORMULAS.length; i += 1) formulas[HOSTS[i]] = FORMULAS[i];
    const open = (): Cells => ({ ...Object.fromEntries(model), ...formulas });
    const place = () => (pick(3) === 0 ? `${'IJKLMNOPQR'[pick(10)]}${1 + pick(2)}` : `${'AB'[pick(2)]}${1 + pick(14)}`);
    const literal = (): Literal => [pick(9), pick(9), pick(9), pick(40) / 4, 'x', 'b', '3', '', true][pick(9)];
    for (let i = 0; i < 12; i += 1) model.set(place(), literal());
    const engine = engineOf({ s1: open() });
    const write = (label: string, value: Literal | null) => {
        if (value === null) {
            model.delete(label);
            engine.clear('s1', ...at(label));
        } else {
            model.set(label, value);
            engine.setValue('s1', ...at(label), value);
        }
    };
    let compared = 0;
    for (let step = 0; step < 150; step += 1) {
        const kind = pick(6);
        if (kind < 2) write(place(), literal());
        else if (kind < 3) write(place(), null);
        else if (kind < 4) write(['G1', 'G4'][pick(2)], [pick(9), pick(9), pick(40) / 4, 'x', ''][pick(5)]);
        else {
            // The last cells of a column or of the two rows, from the end back.
            const column = 'AB'[pick(2)];
            const down = pick(2) === 0;
            let cleared = 0;
            for (let i = down ? 14 : 9; i >= 0 && cleared < 1 + pick(3); i -= 1) {
                const label = down ? `${column}${i}` : `${'IJKLMNOPQR'[i]}${1 + pick(2)}`;
                if (!model.has(label)) continue;
                write(label, null);
                cleared += 1;
            }
        }
        if (pick(3) === 0) continue;
        engine.recalc(Number.POSITIVE_INFINITY);
        const fresh = engineOf({ s1: open() });
        fresh.recalc(Number.POSITIVE_INFINITY);
        for (let i = 0; i < HOSTS.length; i += 1) {
            expect([seed, step, FORMULAS[i], valueAt(engine, HOSTS[i])]).toEqual([
                seed,
                step,
                FORMULAS[i],
                valueAt(fresh, HOSTS[i]),
            ]);
        }
        compared += 1;
    }
    return compared;
}

test.each(Array.from({ length: 60 }, (_, i) => [i + 1]))(
    'after writes and clears every lookup and criterion equals a fresh load: seed %i',
    (seed) => {
        expect(run(seed)).toBeGreaterThan(60);
    },
);

test('the example of the review: a cleared last cell does not bound a bisection', () => {
    const engine = engineOf({ s1: { A6: 0, A10: 5, E1: '=VLOOKUP(G4,A2:B11,1,TRUE)' } });
    engine.recalc(Number.POSITIVE_INFINITY);
    engine.setValue('s1', ...at('A3'), 2);
    engine.clear('s1', ...at('A10'));
    engine.recalc(Number.POSITIVE_INFINITY);
    const fresh = engineOf({ s1: { A3: 2, A6: 0, E1: '=VLOOKUP(G4,A2:B11,1,TRUE)' } });
    fresh.recalc(Number.POSITIVE_INFINITY);
    expect(valueAt(engine, 'E1')).toEqual(valueAt(fresh, 'E1'));
});
