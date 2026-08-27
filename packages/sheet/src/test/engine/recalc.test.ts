import { describe, expect, test } from 'bun:test';
import type { Cell, Sheet } from '@workspace/lib/sheets';
import { recalcSheets, sheetsNeedRecalc } from '../../engine/recalc';

// ── Builders ────────────────────────────────────────────────────────────────

function num(v: number): Cell {
    return { v, m: String(v), ct: { fa: 'General', t: 'n' } };
}

function str(v: string): Cell {
    return { v, m: v, ct: { fa: 'General', t: 's' } };
}

function formula(f: string, cached?: Partial<Cell>): Cell {
    return { f, ...cached };
}

function sheet(id: string, name: string, data: (Cell | null)[][], extra: Partial<Sheet> = {}): Sheet {
    return { id, name, order: 0, config: {}, data, ...extra };
}

type SheetWithChain = Sheet & { calcChain?: { r: number; c: number; id: string }[] };

// ── recalcSheets ────────────────────────────────────────────────────────────

describe('engine/recalc — recalcSheets', () => {
    test('chained dependencies evaluate in order', () => {
        // A1=1 (literal), B1==A1+1, C1==B1+1 → 2, 3
        const sheets = [sheet('s1', 'Sheet1', [[num(1), formula('=A1+1'), formula('=B1+1')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(2);
        expect(out[0].data![0][2]?.v).toBe(3);
    });

    test('forward / upward reference resolves regardless of scan order', () => {
        // A1==A2+A3 (references cells below it), A2==A3*2, A3=5 → A3=5, A2=10, A1=15
        const sheets = [sheet('s1', 'Sheet1', [[formula('=A2+A3')], [formula('=A3*2')], [num(5)]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![2][0]?.v).toBe(5);
        expect(out[0].data![1][0]?.v).toBe(10);
        expect(out[0].data![0][0]?.v).toBe(15);
    });

    test('cross-sheet reference ordered after the referenced formula', () => {
        // Sheet1!A1 == Sheet2!A1 + 10; Sheet2!A1 == 2*3 → Sheet2!A1=6, Sheet1!A1=16
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=Sheet2!A1+10')]]),
            sheet('s2', 'Sheet2', [[formula('=2*3')]]),
        ];
        const out = recalcSheets(sheets);
        const s2 = out.find((s) => s.id === 's2')!;
        const s1 = out.find((s) => s.id === 's1')!;
        expect(s2.data![0][0]?.v).toBe(6);
        expect(s1.data![0][0]?.v).toBe(16);
    });

    test('INDEX-carrying formula is parsed via the special-case branch and evaluates', () => {
        // The isOffsetFunc branch routes INDEX/OFFSET/INDIRECT through the ported
        // isFunctionRange rather than the naive tokenizer (audit Risk 8). INDEX
        // over literals resolves through the range read. (Note: a plain range
        // arg registers no ORDERING dependency — that is the state layer's own
        // behaviour, faithfully preserved: only single-quoted range endpoints do.)
        const sheets = [sheet('s1', 'Sheet1', [[num(10), num(20), formula('=INDEX(A1:B1,1,2)')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][2]?.v).toBe(20);
    });

    test('OFFSET / INDIRECT formulas are handled without crashing (error sentinel)', () => {
        // This engine build has no OFFSET/INDIRECT support → #NAME?. The pass
        // must tolerate the special-cased dependency extraction + evaluation and
        // land an error sentinel, not throw.
        const sheets = [sheet('s1', 'Sheet1', [[num(5), formula('=OFFSET(A1,1,0)'), formula('=INDIRECT("A1")')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe('#NAME?');
        expect(out[0].data![0][1]?.ct?.t).toBe('e');
        expect(out[0].data![0][2]?.v).toBe('#NAME?');
    });

    test('cycle is tolerated — no throw, no hang', () => {
        // A1==B1, B1==A1. Must return without hanging or throwing.
        const sheets = [sheet('s1', 'Sheet1', [[formula('=B1'), formula('=A1')]])];
        expect(() => recalcSheets(sheets)).not.toThrow();
    });

    test('volatile NOW() is frozen — cached value untouched', () => {
        const cachedNow = formula('=NOW()', { v: 44000, m: '2020-06-18', ct: { fa: 'yyyy-MM-dd', t: 'd' } });
        const sheets = [sheet('s1', 'Sheet1', [[cachedNow, formula('=TODAY()', { v: 43999, m: '2020-06-17' })]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(44000);
        expect(out[0].data![0][0]?.m).toBe('2020-06-18');
        expect(out[0].data![0][1]?.v).toBe(43999);
    });

    test('engine error does not clobber a non-error cached value', () => {
        // Functions this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER, …) return
        // #NAME?. At import, Excel's correct cached value must survive — same
        // freeze-is-safe rationale as volatiles.
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=TEXTJOIN(",",1,2)', { v: 7, m: '7', ct: { fa: 'General', t: 'n' } })]]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(7);
        expect(out[0].data![0][0]?.m).toBe('7');
        expect(out[0].data![0][0]?.ct?.t).not.toBe('e');
    });

    test('downstream formula reads the cached value, not the engine error', () => {
        // B1 is an unsupported function with a cached 7; =B1+1 must see 7 → 8,
        // proving the #NAME? never entered the eval cache (execFunctionGlobalData).
        const sheets = [
            sheet('s1', 'Sheet1', [
                [
                    null,
                    formula('=TEXTJOIN(",",1,2)', { v: 7, m: '7', ct: { fa: 'General', t: 'n' } }),
                    formula('=B1+1'),
                ],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(7);
        expect(out[0].data![0][2]?.v).toBe(8);
    });

    test('imported VLOOKUP with a lower-case FALSE resolves against the looked-up sheet', () => {
        // The real shape of a converted-xlsx formula: Excel writes bare booleans lower-cased,
        // and `false` used to resolve as an unknown variable → #NAME?. Neither cell carries a
        // cached value, so a regression lands the sentinel rather than passing silently — and
        // the hit case stops the miss case passing merely by erroring into the fallback.
        const lookup = (ref: string) => `=IFERROR(VLOOKUP(${ref},'MASTER DATA'!A1:B2,2,false),"No input yet")`;
        const sheets = [
            sheet('s1', 'Sheet1', [
                [str('Production'), formula(lookup('A1'))],
                [str('Nothing'), formula(lookup('A2'))],
            ]),
            sheet('s2', 'MASTER DATA', [
                [str('Production'), num(42)],
                [str('Design'), num(7)],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(42);
        expect(out[0].data![1][1]?.v).toBe('No input yet');
    });

    test('engine error with no cached value still writes the #NAME? sentinel', () => {
        // Pin the generator-case behavior: an unsupported function that was never
        // computed (no cached v) lands the error sentinel — better than a silent blank.
        const sheets = [sheet('s1', 'Sheet1', [[formula('=TEXTJOIN(",",1,2)')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe('#NAME?');
        expect(out[0].data![0][0]?.ct?.t).toBe('e');
    });

    test('m derivation — fa mask, error sentinel, plain number', () => {
        const sheets = [
            sheet('s1', 'Sheet1', [
                [formula('=1/4', { ct: { fa: '0.00', t: 'n' } }), formula('=1/0'), formula('=2+2')],
            ]),
        ];
        const out = recalcSheets(sheets);
        // fa-masked
        expect(out[0].data![0][0]?.v).toBe(0.25);
        expect(out[0].data![0][0]?.m).toBe('0.25');
        // error sentinel
        expect(out[0].data![0][1]?.v).toBe('#DIV/0!');
        expect(out[0].data![0][1]?.m).toBe('#DIV/0!');
        expect(out[0].data![0][1]?.ct?.t).toBe('e');
        // plain number
        expect(out[0].data![0][2]?.v).toBe(4);
        expect(out[0].data![0][2]?.m).toBe('4');
    });

    test('boolean result renders TRUE/FALSE', () => {
        const sheets = [sheet('s1', 'Sheet1', [[formula('=2>1'), formula('=2<1')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(true);
        expect(out[0].data![0][0]?.m).toBe('TRUE');
        expect(out[0].data![0][1]?.m).toBe('FALSE');
    });

    test('celldata-only input is materialized and computed', () => {
        const sheets: Sheet[] = [
            {
                id: 's1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [
                    { r: 0, c: 0, v: num(5) },
                    { r: 0, c: 1, v: formula('=A1+1') },
                ],
            },
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(6);
        const entry = out[0].celldata?.find((e) => e.r === 0 && e.c === 1);
        expect(entry?.v?.v).toBe(6);
    });

    test('one poisoned formula does not kill the pass', () => {
        // =NoSheet!A1 throws ERROR_REF (unresolvable sheet name); the sibling
        // formula must still compute.
        const sheets = [sheet('s1', 'Sheet1', [[num(10), formula('=NoSheet!A1'), formula('=A1*3')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][2]?.v).toBe(30);
    });

    test('output carries a populated calcChain for formula cells', () => {
        const out = recalcSheets([sheet('s1', 'Sheet1', [[num(1), formula('=A1+1')]])]) as SheetWithChain[];
        expect(out[0].calcChain).toEqual([{ r: 0, c: 1, id: 's1' }]);
    });
});

// ── sheetsNeedRecalc gate ───────────────────────────────────────────────────

describe('engine/recalc — sheetsNeedRecalc', () => {
    test('false for a doc with no formula cells', () => {
        expect(sheetsNeedRecalc([sheet('s1', 'Sheet1', [[num(1), num(2)]])])).toBe(false);
    });

    test('true for formula cells (data) without a calcChain', () => {
        expect(sheetsNeedRecalc([sheet('s1', 'Sheet1', [[num(1), formula('=A1+1')]])])).toBe(true);
    });

    test('true for formula cells in celldata without a calcChain', () => {
        const s: Sheet = {
            id: 's1',
            name: 'Sheet1',
            order: 0,
            config: {},
            celldata: [{ r: 0, c: 0, v: formula('=1+1') }],
        };
        expect(sheetsNeedRecalc([s])).toBe(true);
    });

    test('false once a calcChain is present (editor-flushed / import-recalced)', () => {
        const s: SheetWithChain = {
            ...sheet('s1', 'Sheet1', [[num(1), formula('=A1+1')]]),
            calcChain: [{ r: 0, c: 1, id: 's1' }],
        };
        expect(sheetsNeedRecalc([s])).toBe(false);
    });

    test('recalc output no longer triggers the gate (idempotent)', () => {
        const out = recalcSheets([sheet('s1', 'Sheet1', [[num(1), formula('=A1+1')]])]);
        expect(sheetsNeedRecalc(out)).toBe(false);
    });
});
