import { describe, expect, test } from 'bun:test';
import type { Literal, SheetSource } from '../../index';
import { Engine, REF } from '../../index';
import { MAX_STORED_LENGTH } from '../../text';
import { runBindLaw } from './bind-law';

const NO_CAP = Number.POSITIVE_INFINITY;

type Held = readonly [row: number, column: number, value: Literal | null, formula: string | null];

const sheet = (id: string, name: string, ...cells: Held[]): SheetSource => ({
    id,
    name,
    cells: (cell) => {
        for (const held of cells) cell(...held);
    },
});
const typed = sheet('a', 'Host', [0, 0, null, "='N'!R1C1+1"]);
const named = sheet('b', 'N', [0, 0, 5, null]);

// Every cell of every sheet, as a host reads the workbook back.
function walk(engine: Engine, ids: readonly string[]): string[] {
    const cells: string[] = [];
    for (const id of ids) {
        engine.cells(id, (row, column, value, formula) => {
            cells.push(`${id} ${row},${column} ${JSON.stringify(value)} ${formula}`);
        });
    }
    return cells;
}
function computed(sources: readonly SheetSource[]): Engine {
    const engine = new Engine(sources);
    engine.recalc(NO_CAP);
    return engine;
}
// A formula whose stored text has `spare` characters left: a long text, a sheet typed as `N` and one no sheet has.
const filling = (spare: number): string =>
    `="${'a'.repeat(MAX_STORED_LENGTH - spare - `=""& 'N'!R1C1&'Gone'!R1C1`.length)}"& 'N'!R1C1&'Gone'!R1C1`;

describe('a formula that enters with the name of a sheet the workbook holds is stored bound to it', () => {
    test.each([
        ['the sheet it names is read after it', [typed, named]],
        ['the sheet it names is read before it', [named, typed]],
    ])('a load, where %s', (_, sources) => {
        const engine = computed(sources);
        expect([engine.formulaOf('a', 0, 0), engine.valueOf('a', 0, 0)]).toEqual(['=[b]!R1C1+1', 6]);
    });
    test('a load binds the name of the sheet a formula stands on', () => {
        const engine = computed([sheet('a', 'Own', [0, 0, 3, null], [1, 0, null, "='own'!R1C1*2"])]);
        expect([engine.formulaOf('a', 1, 0), engine.valueOf('a', 1, 0)]).toEqual(['=[a]!R1C1*2', 6]);
    });
    test('a formula written to a cell, and one filled into a block', () => {
        const engine = computed([sheet('a', 'Host'), named]);
        engine.setFormula('a', 0, 0, "='N'!R1C1+1");
        engine.fillFormula('a', 1, 0, 2, 1, "='n'!R1C1+2");
        expect(engine.formulaOf('a', 0, 0)).toBe('=[b]!R1C1+1');
        expect(engine.formulaOf('a', 2, 1)).toBe('=[b]!R1C1+2');
        engine.recalc(NO_CAP);
        expect([engine.valueOf('a', 0, 0), engine.valueOf('a', 1, 0), engine.valueOf('a', 2, 1)]).toEqual([6, 7, 7]);
    });
    test('every reference of the formula, a name and a deleted cell on the sheet too, and no other workbook', () => {
        const engine = new Engine([sheet('a', 'Host'), named, sheet('c', 'M')]);
        engine.setFormula('a', 0, 0, "=SUM('N'!R1C1:R2C2,'M'!C1:C2)+'N'!Rate+'M'!#REF!+'Gone'!R1C1+'[1]N'!R1C1");
        expect(engine.formulaOf('a', 0, 0)).toBe(
            "=SUM([b]!R1C1:R2C2,[c]!C1:C2)+[b]!Rate+[c]!#REF!+'Gone'!R1C1+'[1]N'!R1C1",
        );
    });
    test('the name is compared as two sheet names are', () => {
        const engine = new Engine([sheet('a', 'Host'), sheet('s', 'ΟΔΟΣ'), sheet('t', 'Straße')]);
        engine.setFormula('a', 0, 0, "='οδος'!R1C1");
        engine.setFormula('a', 1, 0, "='STRAßE'!R1C1");
        engine.setFormula('a', 2, 0, "='STRASSE'!R1C1");
        expect([0, 1, 2].map((row) => engine.formulaOf('a', row, 0))).toEqual([
            '=[s]!R1C1',
            '=[t]!R1C1',
            "='STRASSE'!R1C1",
        ]);
    });
    test('a name no sheet holds stays as typed and reads #REF!', () => {
        const engine = computed([sheet('a', 'Host', [0, 0, null, "='Gone'!R1C1+1"]), named]);
        engine.setFormula('a', 1, 0, "='Gone'!R1C1+1");
        engine.recalc(NO_CAP);
        expect([0, 1].map((row) => [engine.formulaOf('a', row, 0), engine.valueOf('a', row, 0)])).toEqual([
            ["='Gone'!R1C1+1", REF],
            ["='Gone'!R1C1+1", REF],
        ]);
    });
    test('a span of sheets, another workbook and text that does not parse are kept as they are', () => {
        const kept = ["=SUM('N:M'!R1C1)", "='[1]N'!R1C1+1", "=SUM('N'!R1C1"];
        const engine = new Engine([
            sheet('a', 'Host', ...kept.map((text, row): Held => [row, 0, 4, text])),
            named,
            sheet('c', 'M'),
        ]);
        for (const [row, text] of kept.entries()) engine.setFormula('a', row, 1, text, 4);
        expect([0, 1, 2].flatMap((row) => [engine.formulaOf('a', row, 0), engine.formulaOf('a', row, 1)])).toEqual(
            kept.flatMap((text) => [text, text]),
        );
        expect([0, 1].map((row) => engine.isGiven('a', row, 1))).toEqual([true, true]);
    });
    test('a rename away and back changes no stored text and no value', () => {
        const ids = ['a', 'b'];
        const engine = computed([typed, named]);
        const before = walk(engine, ids);
        expect(engine.renameSheet('b', 'Y').rewrites).toEqual([]);
        engine.recalc(NO_CAP);
        expect(walk(engine, ids)).toEqual(before);
        expect(engine.renameSheet('b', 'N').rewrites).toEqual([]);
        engine.recalc(NO_CAP);
        expect(walk(engine, ids)).toEqual(before);
        expect(walk(computed([typed, named]), ids)).toEqual(before);
    });
    test('a sheet that gets a name no sheet had is bound by the rename, which reports the text as lost', () => {
        const engine = computed([typed, sheet('b', 'Y', [0, 0, 5, null])]);
        expect(engine.formulaOf('a', 0, 0)).toBe("='N'!R1C1+1");
        expect(engine.renameSheet('b', 'N').rewrites).toEqual([
            { sheet: 'a', top: 0, left: 0, bottom: 0, right: 0, formula: '=[b]!R1C1+1', lost: "='N'!R1C1+1" },
        ]);
        // The typed text is still a shape of the table here, which no cell holds any more.
        engine.setFormula('a', 1, 0, "='N'!R1C1+1");
        expect(engine.formulaOf('a', 1, 0)).toBe('=[b]!R1C1+1');
        // Taken back in the order a host does: the rename, then the text it lost.
        engine.renameSheet('b', 'Y');
        engine.setFormula('a', 0, 0, "='N'!R1C1+1");
        engine.recalc(NO_CAP);
        expect([engine.formulaOf('a', 0, 0), engine.valueOf('a', 0, 0)]).toEqual(["='N'!R1C1+1", REF]);
        expect([engine.formulaOf('a', 1, 0), engine.valueOf('a', 1, 0)]).toEqual(['=[b]!R1C1+1', 6]);
    });
    test('a sheet that comes is bound in what named it, reported as lost, and its own formulas as they enter', () => {
        const engine = computed([typed, sheet('c', 'M', [0, 0, 2, null])]);
        const added = engine.addSheet(
            sheet(
                'b',
                'N',
                [0, 0, 5, null],
                [1, 0, 9, "='M'!R1C1+'n'!R1C1"],
                [2, 0, 9, "='host'!R1C1"],
                [3, 0, 9, "='Gone'!R1C1"],
            ),
            1,
        );
        expect(added.rewrites).toEqual([
            { sheet: 'a', top: 0, left: 0, bottom: 0, right: 0, formula: '=[b]!R1C1+1', lost: "='N'!R1C1+1" },
        ]);
        expect([1, 2, 3].map((row) => engine.formulaOf('b', row, 0))).toEqual([
            '=[c]!R1C1+[b]!R1C1',
            '=[a]!R1C1',
            "='Gone'!R1C1",
        ]);
        engine.recalc(NO_CAP);
        expect([engine.valueOf('a', 0, 0), engine.valueOf('b', 1, 0), engine.valueOf('b', 2, 0)]).toEqual([6, 7, 6]);
    });
    test('the name of a sheet that went is the name of no sheet, until one comes with it', () => {
        const engine = computed([typed, named]);
        engine.removeSheet('b');
        engine.setFormula('a', 1, 0, "='N'!R1C1");
        expect(engine.formulaOf('a', 1, 0)).toBe("='N'!R1C1");
        const { rewrites } = engine.addSheet(named, 1);
        expect(rewrites.map((rewrite) => [rewrite.top, rewrite.formula, rewrite.lost])).toEqual([
            [1, '=[b]!R1C1', "='N'!R1C1"],
        ]);
    });
});

describe('a reference whose sheet is held and whose bound text would not fit a cell is stored as #REF!', () => {
    const long = sheet('a-long-id-of-a-sheet', 'N', [0, 0, 5, null]);
    // One character too long once it is bound, and exactly as long as a cell stores.
    const text = filling(18);
    const fits = filling(19);
    const broken = text.replace("'N'!R1C1", '#REF!');
    const doors: [string, (formula: string) => Engine][] = [
        ['a load', (formula) => new Engine([sheet('a', 'Host', [0, 0, null, formula]), long])],
        [
            'a formula written to a cell',
            (formula) => {
                const engine = new Engine([sheet('a', 'Host'), long]);
                engine.setFormula('a', 0, 0, formula);
                return engine;
            },
        ],
        [
            'a formula filled into a block',
            (formula) => {
                const engine = new Engine([sheet('a', 'Host'), long]);
                engine.fillFormula('a', 0, 0, 1, 1, formula);
                return engine;
            },
        ],
        [
            'a sheet that comes',
            (formula) => {
                const engine = new Engine([long]);
                engine.addSheet(sheet('a', 'Host', [0, 0, 1, formula]), 0);
                return engine;
            },
        ],
    ];
    test.each(doors)('%s', (_, enter) => {
        const engine = enter(text);
        expect(engine.formulaOf('a', 0, 0)).toBe(broken);
        engine.recalc(NO_CAP);
        expect(engine.valueOf('a', 0, 0)).toBe(REF);
        // No rename has anything left to bind, so none is refused, and the text reads back as itself.
        const before = walk(engine, ['a']);
        expect(engine.renameSheet('a-long-id-of-a-sheet', 'Y').rewrites).toEqual([]);
        expect(engine.renameSheet('a-long-id-of-a-sheet', 'N').rewrites).toEqual([]);
        engine.recalc(NO_CAP);
        expect(walk(engine, ['a'])).toEqual(before);
        expect(new Engine([sheet('a', 'Host', [0, 0, 1, broken]), long]).formulaOf('a', 0, 0)).toBe(broken);
    });
    test.each(doors)('%s, with a text that just fits bound', (_, enter) => {
        const engine = enter(fits);
        const bound = fits.replace("'N'!", '[a-long-id-of-a-sheet]!');
        expect(bound).toHaveLength(MAX_STORED_LENGTH);
        expect(engine.formulaOf('a', 0, 0)).toBe(bound);
    });
    test('the same text with the name of no sheet is kept, and the rename that would bind it is refused', () => {
        const engine = new Engine([sheet('a', 'Host', [0, 0, 1, text]), { ...long, name: 'Y' }]);
        expect(engine.formulaOf('a', 0, 0)).toBe(text);
        expect(() => engine.renameSheet('a-long-id-of-a-sheet', 'N')).toThrow('too-long');
        expect(engine.formulaOf('a', 0, 0)).toBe(text);
    });
});

describe('the binding law', () => {
    // A long run by hand: BIND_LAW_SEED=7 BIND_LAW_COUNT=5000 bun test ./src/test/recalc/bind.test.ts
    const seed = Number(process.env['BIND_LAW_SEED'] ?? 1);
    const count = Number(process.env['BIND_LAW_COUNT'] ?? 300);
    test('no held formula names a held sheet by name, and every edit taken back leaves the workbook it met', () => {
        const counts = runBindLaw(seed, count, 24);
        console.log('bind law', JSON.stringify(counts));
        expect(counts.undone).toBe(counts.steps);
        expect(counts.bound).toBeGreaterThan(count);
        expect(counts.lost).toBeGreaterThan(count / 4);
        for (const kind of [counts.writes, counts.adds, counts.renames, counts.removes]) {
            expect(kind).toBeGreaterThan(count);
        }
    }, 120_000);
});
