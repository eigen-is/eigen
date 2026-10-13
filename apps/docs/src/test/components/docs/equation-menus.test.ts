// Google Docs' equation menus, as checked in its editor: every item is a command the LaTeX reader knows, so a cell
// inserts what the field can commit.
import { expect, test } from 'bun:test';
import { LATEX_COMMANDS, readLatex } from '@workspace/math';
import { EQUATION_MENUS } from '../../../components/docs/equation-menus';

test("the five menus hold Google's items", () => {
    expect(EQUATION_MENUS.map((menu) => [menu.label, menu.items.length])).toEqual([
        ['Greek letters', 40],
        ['Miscellaneous operations', 32],
        ['Relations', 21],
        ['Math operations', 20],
        ['Arrows', 12],
    ]);
});

test('every symbol is a symbol in the command table, inserted with a space after it', () => {
    for (const menu of EQUATION_MENUS.filter(({ label }) => label !== 'Math operations')) {
        for (const item of menu.items) {
            expect([item.name, LATEX_COMMANDS.get(item.name)?.kind]).toEqual([item.name, 'symbol']);
            expect(item.insert).toBe(`\\${item.name} `);
        }
    }
});

test('every cell draws and inserts LaTeX the reader reads, its empty slots left out of the insert', () => {
    for (const item of EQUATION_MENUS.flatMap((menu) => menu.items)) {
        expect(() => readLatex(item.preview)).not.toThrow();
        expect(() => readLatex(item.insert)).not.toThrow();
        expect(item.insert).not.toContain('\\Box');
    }
    const operations = EQUATION_MENUS.find(({ label }) => label === 'Math operations');
    expect(operations?.items.slice(0, 4).map((item) => item.insert)).toEqual([
        '\\frac{}{}',
        '\\sqrt{}',
        '\\sqrt[]{}',
        '_{}^{}',
    ]);
});
