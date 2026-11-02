import { describe, expect, test } from 'bun:test';
import type { Cell, Sheet } from '@workspace/lib/sheets';
import { extractDependencies, recalcSheets, sheetsNeedRecalc } from '../../engine/recalc';

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
    // A rich-text cell keeps its text in its runs alone, as the editor writes one and the xlsx import too.
    test('a formula reads a rich-text cell as its runs, before and after an edit of them', () => {
        const rich = (...runs: string[]): Cell => ({
            ct: { fa: 'General', t: 'inlineStr', s: runs.map((v) => ({ v, bl: 1 })) },
        });
        const before = recalcSheets([sheet('s1', 'Sheet1', [[rich('Hello ', 'world'), formula('=A1&"!"')]])]);
        expect(before[0].data![0][1]?.v).toBe('Hello world!');
        const after = recalcSheets([sheet('s1', 'Sheet1', [[rich('Bye'), formula('=A1&"!"')]])]);
        expect(after[0].data![0][1]?.v).toBe('Bye!');
    });

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

    test("a quoted sheet name with an operator in it, as in ='1-2'!A1+5, orders its formula after that cell", () => {
        // Sheet1 is scanned first, so only a recorded dependency makes it read the fresh 6 over the cached 0.
        const sheets = [
            sheet('s1', 'Sheet1', [[formula("='1-2'!A1+5")]]),
            sheet('s2', '1-2', [[formula('=2*3', { v: 0 })]]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data?.[0][0]?.v).toBe(11);
    });

    test('a formula that starts and ends with a string, as ="x"&B1&"y" does, still reads the cells between', () => {
        // A1 is scanned first, so only a recorded dependency makes it read B1's fresh 6 over the cached 0.
        const sheets = [sheet('s1', 'Sheet1', [[formula('="x"&B1&"y"'), formula('=2*3', { v: 0 })]])];
        const out = recalcSheets(sheets);
        expect(out[0].data?.[0][0]?.v).toBe('x6y');
    });

    test("a formula orders after the cells an INDEX's range argument reads", () => {
        // A1 is scanned first, so only a recorded dependency makes it read C1's fresh 6 over the cached 0.
        const sheets = [sheet('s1', 'Sheet1', [[formula('=INDEX(B1:C1,1,2)'), num(10), formula('=2*3', { v: 0 })]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(6);
    });

    test('a formula orders after the cells a whole column or row reads, on its sheet or another', () => {
        // Each formula is scanned before the cell it reads, whose cached 0 is stale.
        const sheets = [
            sheet('s1', 'Sheet1', [
                [formula('=SUM(B:B)'), formula('=2*3', { v: 0 }), formula('=SUM(Data!A:A)')],
                [null, null, formula('=SUM(Data!2:2)')],
                [null, null, formula('=SUM(4:4)')],
                [formula('=4*5', { v: 0 })],
            ]),
            sheet('s2', 'Data', [
                [formula('=7*1', { v: 0 }), null],
                [num(1), formula('=8*1', { v: 0 })],
            ]),
        ];
        const out = recalcSheets(sheets);
        const sheet1 = out[0].data!;
        expect([sheet1[0][0]?.v, sheet1[0][2]?.v, sheet1[1][2]?.v, sheet1[2][2]?.v]).toEqual([6, 8, 9, 20]);
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

    test('a reversed range orders its formula after the cells it reads', () => {
        // B1 is scanned before A2, so only a recorded dependency makes it read A2's fresh 10.
        const sheets = [
            sheet('s1', 'Sheet1', [[num(1), formula('=SUM(A3:A1)')], [formula('=5*2')], [num(3)]]),
            sheet('s2', 'Sheet2', [[formula('=SUM(Sheet1!B$3:Sheet1!A1)')]]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(14);
        expect(out[1].data![0][0]?.v).toBe(28);
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
        // Functions this build lacks (LET, FILTER, …) return
        // #NAME?. At import, Excel's correct cached value must survive — same
        // freeze-is-safe rationale as volatiles.
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=FILTER(1,2)', { v: 7, m: '7', ct: { fa: 'General', t: 'n' } })]]),
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
                [null, formula('=FILTER(1,2)', { v: 7, m: '7', ct: { fa: 'General', t: 'n' } }), formula('=B1+1')],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(7);
        expect(out[0].data![0][2]?.v).toBe(8);
    });

    // An Excel function the engine lacks fails the whole formula, past IFERROR and ISERROR, so Excel's value stays.
    test('a formula naming a function the engine lacks keeps its cached value, inside IFERROR or ISERROR too', () => {
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=IFERROR(FILTER(A1:A3,A1:A3>1),"none")', num(2))],
                [num(2), formula('=IF(ISERROR(_xlfn.LET(x,A1,x+1)),0,1)', num(1))],
                [num(3), formula('=B1+1')],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(2);
        expect(out[0].data![1][1]?.v).toBe(1);
        // A cell that reads it sees the cached value, not the fallback.
        expect(out[0].data![2][1]?.v).toBe(3);
    });

    test('a formula whose functions the engine knows recalculates under IFERROR, past a stale cached value', () => {
        // Text that reads like a call or a name is neither, and nor is a boolean, a number or another sheet's cell.
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=IFERROR(SQRT(A1-2),"FILTER( Rate")', num(5))],
                [num(2), formula("=IF(true,Sheet2!A1+'Sheet 3'!A1*1.5E0,FALSE)", num(5))],
            ]),
            sheet('s2', 'Sheet2', [[num(10)]]),
            sheet('s3', 'Sheet 3', [[num(2)]]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe('FILTER( Rate');
        expect(out[0].data![1][1]?.v).toBe(13);
    });

    // Excel never evaluates the branch IF skips, so the engine computes what Excel did.
    test('a function the engine lacks in a branch IF skips recalculates past a stale cached value', () => {
        const sheets = [sheet('s1', 'Sheet1', [[num(1), formula('=IF(A1>0,A1+1,FILTER(A1:A3,TRUE))', num(5))]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(2);
    });

    // The importer writes each defined name into the formulas that use it. One it can't, such as a name into another
    // workbook, stays as written, and the engine has no names, so IFERROR would hand back its fallback.
    test("a formula using a defined name the import couldn't inline keeps its cached value, inside IFERROR too", () => {
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=IFERROR(A1*TaxRate,0)', num(0.21))],
                // Excel reads a name past its last column, XFD, as a name, where the engine reads a cell.
                [num(2), formula('=IFERROR(A2*RhoCO2,0)', num(3.6))],
                [num(3), formula('=IFERROR(Sheet1!Discount,7)', num(5)), formula('=B1*100')],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][1]?.v).toBe(0.21);
        expect(out[0].data![1][1]?.v).toBe(3.6);
        expect(out[0].data![2][1]?.v).toBe(5);
        // A cell that reads one sees the cached value.
        expect(out[0].data![2][2]?.v).toBe(21);
    });

    // An imported formula holds the error Excel computed, which recalc computes again before the cells that read it.
    test('an error a formula computes is one to the formulas that read it, as Excel computed them', () => {
        const error = (v: string): Partial<Cell> => ({ v, m: v, ct: { fa: 'General', t: 's' } });
        const flag = (v: boolean): Partial<Cell> => ({ v, m: v ? 'TRUE' : 'FALSE', ct: { fa: 'General', t: 'b' } });
        const sheets = [
            sheet('s1', 'Sheet1', [
                [formula('=1/0', error('#DIV/0!')), formula('=ISERROR(A1)', flag(true)), formula('=ISNA(A1)')],
                [formula('=IFERROR(A1,"none")'), formula('=ERROR.TYPE(A1)'), formula('=A1+1')],
                [str('#DIV/0!'), formula('=ISERROR(A3)', flag(false)), formula('=SUM(A1,1)')],
            ]),
            sheet('s2', 'Sheet2', [[formula('=IFERROR(Sheet1!A1,0)', num(0))]]),
        ];
        const out = recalcSheets(sheets);
        const values = out[0].data!.map((row) => row.map((cell) => cell?.v));
        expect(values).toEqual([
            ['#DIV/0!', true, false],
            ['none', 2, '#DIV/0!'],
            ['#DIV/0!', false, '#DIV/0!'],
        ]);
        expect(out[1].data![0][0]?.v).toBe(0);
    });

    // A #NAME? stands in for the value of a function the engine lacks, so the guard keeps the reader's cached value.
    test("a formula reading a function the engine lacks keeps its cached value, or shows #NAME?, never IFERROR's fallback", () => {
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=FILTER(A1:A2,A1:A2>0)'), formula('=IFERROR(B1,"none")', num(1))],
                [num(2), formula('=IFERROR(B1,"none")'), formula('=ISERROR(B1)')],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][2]?.v).toBe(1);
        expect(out[0].data![1][1]?.v).toBe('#NAME?');
        expect(out[0].data![1][2]?.v).toBe('#NAME?');
    });

    // Only an error string is an error: a cached text that starts with # is a value the guard keeps.
    test('a cached text that starts with # is kept over a function the engine lacks', () => {
        const sheets = [sheet('s1', 'Sheet1', [[num(1), formula('=FILTER(A1:A2,A1:A2>0)', str('#tag'))]])];
        expect(recalcSheets(sheets)[0].data![0][1]?.v).toBe('#tag');
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

    test('an imported XLOOKUP recalculates after its input changed', () => {
        // Excel's cached 2 predates the edit of B2 to 5.
        const sheets = [
            sheet('s1', 'Sheet1', [
                [str('a'), num(1), num(10), formula('=XLOOKUP("b",A1:A2,B1:B2)', num(2))],
                [str('b'), num(5), num(50), formula('=XLOOKUP("b",A1:A2,B1:C2)', num(2))],
            ]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][3]?.v).toBe(5);
        // A row-wide return is a spill anchor, which holds the row's first value.
        expect(out[0].data![1][3]?.v).toBe(5);
    });

    test('engine error with no cached value still writes the #NAME? sentinel', () => {
        // Pin the generator-case behavior: an unsupported function that was never
        // computed (no cached v) lands the error sentinel — better than a silent blank.
        const sheets = [sheet('s1', 'Sheet1', [[formula('=FILTER(1,2)')]])];
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

    test('a malformed number format shows the result as General', () => {
        const sheets = [sheet('s1', 'Sheet1', [[formula('=2+2', { ct: { fa: '#,##0;;;;;', t: 'n' } })]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(4);
        expect(out[0].data![0][0]?.m).toBe('4');
    });

    test('a float-noise General result keeps its full value and shows the rounded 0.3', () => {
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=0.1+0.2', { ct: { fa: 'General', t: 'n' } }), formula('=0.1+0.2')]]),
        ];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(0.30000000000000004);
        expect(out[0].data![0][0]?.m).toBe('0.3');
        expect(out[0].data![0][1]?.m).toBe('0.3');
    });

    test('boolean result renders TRUE/FALSE', () => {
        const sheets = [sheet('s1', 'Sheet1', [[formula('=2>1'), formula('=2<1')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(true);
        expect(out[0].data![0][0]?.m).toBe('TRUE');
        expect(out[0].data![0][1]?.m).toBe('FALSE');
    });

    test('date result keeps the imported serial and its masked display', () => {
        // The xlsx-imported shape: Excel's cached serial + a real date mask. A
        // stringified Date here exports as a text cell and loses the date.
        const cached = { v: 46027, m: '2026-01-05', ct: { fa: 'yyyy-mm-dd', t: 'd' } };
        const sheets = [sheet('s1', 'Sheet1', [[formula('=DATE(2026,1,5)', cached)]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(46027);
        expect(out[0].data![0][0]?.m).toBe('2026-01-05');
    });

    test('EOMONTH over a serial writes the month-end serial', () => {
        // A2 is 2026-01-05 as a serial; EOMONTH(A2,0) is 2026-01-31.
        const sheets = [sheet('s1', 'Sheet1', [[formula('=EOMONTH(A2,0)')], [num(46027)]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][0]?.v).toBe(46053);
        expect(out[0].data![0][0]?.m).toBe('46053');
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

    test('a sheet name in another case reads that sheet, as in Excel', () => {
        const sheets = [sheet('s1', 'Sheet1', [[formula('=data!A1*2')]]), sheet('s2', 'Data', [[num(4)]])];
        expect(recalcSheets(sheets)[0].data![0][0]?.v).toBe(8);
    });

    // A workbook stored before a rename compared names in any case can hold both.
    test('in a workbook holding Data and data, each name reads its own sheet', () => {
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=data!A1'), formula('=Data!A1'), formula('=DATA!A1')]]),
            sheet('s2', 'Data', [[num(1)]]),
            sheet('s3', 'data', [[num(2)]]),
        ];
        expect(recalcSheets(sheets)[0].data?.[0].map((cell) => cell?.v)).toEqual([2, 1, 1]);
    });

    // A stored matrix may lack rows, its first among them, so a whole row reads as wide as the sheet's widest row.
    test('a whole row reads to the last column of a sheet whose first row is short', () => {
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=SUM(Holey!2:2)'), formula('=SUM(Holey!A2:C2)')]]),
            sheet('s2', 'Holey', [[], [num(1), num(2)]]),
        ];
        const [out] = recalcSheets(sheets);
        expect([out.data![0][0]?.v, out.data![0][1]?.v]).toEqual([3, 3]);
    });

    // Excel ignores a space that isn't between two references. A zenodo workbook writes =IF((AN38+ AO38         )<>0,…)
    // over a number and the empty text another formula gives, and caches #VALUE!, as 1 + "" is in Excel.
    test('spaces around an operand change nothing, and a number plus empty text is #VALUE!', () => {
        const spaced = '=IF((A1+ B1         )<>0,A1,    "")';
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), num(2), formula(spaced), formula('= A1 +B1 '), formula('=SUM( A1 , B1 )')],
                [num(1), formula('=""'), formula(spaced.replaceAll('1', '2'))],
            ]),
        ];
        const [out] = recalcSheets(sheets);
        expect(out.data![0].slice(2).map((cell) => cell?.v)).toEqual([1, 3, 3]);
        expect(out.data![1][2]?.v).toBe('#VALUE!');
    });

    test('one poisoned formula does not kill the pass', () => {
        // =NoSheet!A1 throws ERROR_REF (unresolvable sheet name); the sibling
        // formula must still compute.
        const sheets = [sheet('s1', 'Sheet1', [[num(10), formula('=NoSheet!A1'), formula('=A1*3')]])];
        const out = recalcSheets(sheets);
        expect(out[0].data![0][2]?.v).toBe(30);
    });

    test('past its dependency budget a recalc throws before it computes', () => {
        // On a sheet 129 rows deep, A1:A128 meets 2 blocks of 64 × 16, D1:D2 one.
        const rows = Array.from({ length: 129 }, (): (Cell | null)[] => [null, null, null, null]);
        rows[0] = [num(1), formula('=SUM(A1:A128)', num(7)), formula('=SUM(D1:D2)'), null];
        const sheets = [sheet('s1', 'Sheet1', rows)];
        expect(() => recalcSheets(sheets, { maxDependencySlots: 2 })).toThrow(RangeError);
        expect(recalcSheets(sheets, { maxDependencySlots: 3 })[0].data![0][1]?.v).toBe(1);
    });

    test('a range down every row of its sheet costs the budget one per column', () => {
        // Data is 6,400 rows deep, so each Data!A:A would meet 100 blocks of 64 × 16.
        const data = Array.from({ length: 6_400 }, (): (Cell | null)[] => [num(1), null]);
        const report = Array.from({ length: 10 }, (): (Cell | null)[] => [formula('=SUM(Data!A:A)')]);
        const sheets = [sheet('d', 'Data', data), sheet('r', 'Report', report)];
        expect(() => recalcSheets(sheets, { maxDependencySlots: 9 })).toThrow(RangeError);
        expect(recalcSheets(sheets, { maxDependencySlots: 10 })[1].data?.[9][0]?.v).toBe(6_400);
    });

    // Each formula in column A reads the whole column, so each of the four is read by all four: 16 links, though the
    // index lists the column once per formula.
    test('past its edge budget a recalc throws before it links the formulas', () => {
        const rows = Array.from({ length: 4 }, (): (Cell | null)[] => [formula('=COUNT(A:A)')]);
        const sheets = [sheet('s1', 'Sheet1', rows)];
        expect(() => recalcSheets(sheets, { maxDependencyEdges: 15 })).toThrow(RangeError);
        expect(() => recalcSheets(sheets, { maxDependencyEdges: 16 })).not.toThrow();
    });

    // The 32 formulas in A1:A32 read B41:B42, which lies in their 64 × 16 block. So the lookup of each formula cell
    // visits all 32 ranges and finds none covering it: 1,024 visits that make no link.
    test('past its visit budget a recalc throws, though the ranges near the formula cells make no link', () => {
        const rows = Array.from({ length: 64 }, (_, r): (Cell | null)[] => [
            r < 32 ? formula('=SUM(B41:B42)') : null,
            null,
        ]);
        const sheets = [sheet('s1', 'Sheet1', rows)];
        expect(() => recalcSheets(sheets, { maxDependencyVisits: 1_023 })).toThrow(RangeError);
        expect(() => recalcSheets(sheets, { maxDependencyVisits: 1_024, maxDependencyEdges: 0 })).not.toThrow();
    });

    test('past its budget of cells read a recalc throws, before it reads them', () => {
        // SUM(A1:A3) reads 3 cells, SUM(A1:A2) 2.
        const sheets = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=SUM(A1:A3)')],
                [num(2), formula('=SUM(A1:A2)')],
                [num(3), null],
            ]),
        ];
        expect(() => recalcSheets(sheets, { maxCellsRead: 4 })).toThrow(RangeError);
        // A formula failing on the budget keeps its cached value, which must not let the pass carry on.
        const cached = [
            sheet('s1', 'Sheet1', [
                [num(1), formula('=SUM(A1:A2)', num(9))],
                [num(2), null],
            ]),
        ];
        expect(() => recalcSheets(cached, { maxCellsRead: 1 })).toThrow(RangeError);
        const out = recalcSheets(sheets, { maxCellsRead: 5 });
        expect([out[0].data![0][1]?.v, out[0].data![1][1]?.v]).toEqual([6, 3]);
    });

    test('a range past the sheets is charged and indexed for the cells they hold', () => {
        // A1 reads C1 through the whole grid's range, so C1 computes first; the range costs the one block the sheet spans.
        const sheets = [
            sheet('s1', 'Sheet1', [[formula('=SUM(B1:XFD1048576)'), num(5), formula('=B1+1')]], { row: 1, column: 3 }),
        ];
        expect(recalcSheets(sheets, { maxDependencySlots: 1 })[0].data![0][0]?.v).toBe(11);
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

    test('false for an id-less sheet — recalcSheets skips it, so it must not arm the gate', () => {
        const idless: Sheet = { name: 'Loose', order: 0, config: {}, data: [[num(1), formula('=A1+1')]] };
        expect(sheetsNeedRecalc([idless])).toBe(false);
        expect(recalcSheets([idless])[0]).toBe(idless);
    });

    test('recalc output of a doc carrying an id-less sheet no longer triggers the gate', () => {
        const idless: Sheet = { name: 'Loose', order: 0, config: {}, data: [[num(1), formula('=A1+1')]] };
        const out = recalcSheets([sheet('s1', 'Sheet1', [[num(1), formula('=A1+1')]]), idless]);
        expect(sheetsNeedRecalc(out)).toBe(false);
    });
});

describe('engine/recalc — extractDependencies', () => {
    // Each quoted sheet name is glued to the reference after it as the formula is split, never by moving the rest of
    // the parts, so a crafted file can't make the walk quadratic.
    test('walks a 2 MB formula of quoted sheet names in well under a second', () => {
        const g = { sheets: [{ id: 's2', name: 'My Data', data: [[num(1)]] }], cellTextToIndexList: {} };
        const f = `=${"'My Data'!A1+".repeat(160_000)}1`;
        expect(f.length).toBeGreaterThan(2_000_000);
        const start = performance.now();
        const deps = extractDependencies(g, f, 's1', null);
        expect(performance.now() - start).toBeLessThan(1_000);
        expect(deps).toHaveLength(160_000);
        expect(deps[0]).toEqual({ row: [0, 0], column: [0, 0], sheetId: 's2' });
    });

    // A function's name is matched only where a word starts, so a long run of letters with no bracket after it is
    // read once, not once per letter.
    test('walks a 1 MB run of letters in well under a second', () => {
        const g = { sheets: [{ id: 's1', name: 'Sheet1', data: [[num(1)]] }], cellTextToIndexList: {} };
        const start = performance.now();
        expect(extractDependencies(g, `=${'A'.repeat(1_000_000)}`, 's1', [[num(1)]])).toEqual([]);
        expect(performance.now() - start).toBeLessThan(1_000);
    });

    test("a function's name reads as no cell, after an operator or a colon", () => {
        const data = [[num(1), num(2)]];
        const g = { sheets: [{ id: 's1', name: 'Sheet1', data }], cellTextToIndexList: {} };
        expect(extractDependencies(g, '=LOG10(A1)+ATAN2(B2,1)', 's1', data)).toEqual([
            { row: [0, 0], column: [0, 0], sheetId: 's1' },
            { row: [1, 1], column: [1, 1], sheetId: 's1' },
        ]);
        expect(extractDependencies(g, '=A1:INDEX(B:B,1)', 's1', data)).toEqual([
            { row: [0, 0], column: [0, 0], sheetId: 's1' },
            { row: [0, 0], column: [1, 1], sheetId: 's1' },
        ]);
    });
});
