// The binding law, as a run others can start with a seed and a count: random workbooks whose formulas name sheets
// by id and by typed names, some held and some not, driven through the public engine by writes, sheets that come,
// go and are renamed, each taken back at once. After every step no held formula names a held sheet by name and a
// fresh load of what the engine holds is the same workbook; after every undo the workbook is the one before.

import type { Literal, Rewrite, SheetSource } from '../../index';
import { Engine } from '../../index';
import type { FormulaNode } from '../../text';
import { parseStored, SheetKind, sheetNameKey } from '../../text';
import { random } from '../edit/support';

const NO_CAP = Number.POSITIVE_INFINITY;

// Names that meet in another case, that only look alike, and that no sheet starts with.
const NAMES = ['N', 'n', 'Data', 'DATA', 'Straße', 'STRASSE', 'ΟΔΟΣ', 'οδος', 'Later', 'Y', "It's"];
const IDS = ['a', 'b', 'c', 'd', 'a-long-id', 'e'];
const ROWS = 4;
const COLUMNS = 3;

type Cell = {
    readonly row: number;
    readonly column: number;
    readonly value: Literal | null;
    readonly formula: string | null;
};
type Held = { readonly id: string; readonly name: string; readonly cells: readonly Cell[] };

// An edit to perform, which answers with what takes it back.
type Edit = () => () => void;

export type BindCounts = {
    workbooks: number;
    steps: number;
    undone: number;
    writes: number;
    adds: number;
    renames: number;
    removes: number;
    // The formulas that entered typed with the name of a held sheet, and the texts an edit reported as lost.
    bound: number;
    lost: number;
    loads: number;
};

function leaves(node: FormulaNode, visit: (leaf: FormulaNode) => void): void {
    if (node.children.length === 0) visit(node);
    for (const child of node.children) leaves(child, visit);
}

function source({ id, name, cells }: Held): SheetSource {
    return {
        id,
        name,
        cells: (cell) => {
            for (const held of cells) cell(held.row, held.column, held.value, held.formula);
        },
    };
}

export function runBindLaw(seed: number, count: number, steps: number): BindCounts {
    const pick = random(seed);
    const one = <T>(list: readonly T[]): T => list[pick(list.length)];
    const counts: BindCounts = {
        workbooks: 0,
        steps: 0,
        undone: 0,
        writes: 0,
        adds: 0,
        renames: 0,
        removes: 0,
        bound: 0,
        lost: 0,
        loads: 0,
    };
    for (let book = 0; book < count; book += 1) {
        const log: string[] = [];
        const fail = (what: string): never => {
            throw new Error(`${what}\nseed ${seed} book ${book}\n${log.join('\n')}\n`);
        };
        // The sheets in tab order, as the engine is told: what it holds is read from the engine.
        let sheets: { id: string; name: string }[] = [];
        const free = (name: string) => sheets.every((sheet) => sheetNameKey(sheet.name) !== sheetNameKey(name));
        const quoted = (name: string) => `'${name.replaceAll("'", "''")}'`;
        const reference = (): string => {
            const drawn = pick(8);
            const cell = `R${1 + pick(ROWS)}C${1 + pick(COLUMNS)}`;
            if (drawn === 0) return cell;
            if (drawn < 3) return `[${one(IDS)}]!${cell}`;
            if (drawn === 3) return `'[1]${one(NAMES)}'!${cell}`;
            return `${quoted(one(NAMES))}!${cell}`;
        };
        const formula = (): string => {
            const drawn = pick(6);
            if (drawn === 0) return `=SUM(${reference()},${reference()})`;
            if (drawn === 1) return `=${reference()}&"x"`;
            if (drawn === 2) return `=SUM(${reference()}`;
            return `=${reference()}+${1 + pick(3)}`;
        };
        const content = (): Cell[] => {
            const cells = new Map<string, Cell>();
            for (let i = 0; i < 6; i += 1) {
                const row = pick(ROWS);
                const column = pick(COLUMNS);
                const text = pick(3) === 0 ? null : formula();
                cells.set(`${row},${column}`, {
                    row,
                    column,
                    value: text === null ? 1 + pick(9) : null,
                    formula: text,
                });
            }
            return [...cells.values()];
        };
        const names = (): string => {
            for (;;) {
                const name = one(NAMES);
                if (free(name)) return name;
            }
        };

        const first: Held[] = [];
        for (const id of IDS.slice(0, 2 + pick(2))) {
            const held = { id, name: names(), cells: content() };
            first.push(held);
            sheets.push({ id, name: held.name });
        }
        const engine = new Engine(first.map(source), 0, 0, false);
        engine.recalc(NO_CAP);
        log.push(`load ${JSON.stringify(first)}`);

        const read = (from: Engine): Held[] =>
            sheets.map(({ id, name }) => {
                const cells: Cell[] = [];
                from.cells(id, (row, column, value, text) => cells.push({ row, column, value, formula: text }));
                return { id, name, cells };
            });
        // The engine holds the invariant, and what it holds means the same to a reader that loads it.
        const check = (): string => {
            const held = read(engine);
            const keys = new Set(sheets.map((sheet) => sheetNameKey(sheet.name)));
            for (const sheet of held) {
                for (const cell of sheet.cells) {
                    if (cell.formula === null) continue;
                    const tree = parseStored(cell.formula);
                    if ('reason' in tree) continue;
                    leaves(tree, (leaf) => {
                        if (leaf.sheetKind === SheetKind.Name && keys.has(sheetNameKey(leaf.sheet))) {
                            fail(`${sheet.id} ${cell.row},${cell.column} names a held sheet: ${cell.formula}`);
                        }
                    });
                }
            }
            const walked = JSON.stringify(held);
            // A reader that meets the sheets in another order, and never computed them.
            const order = pick(2) === 0 ? held : held.slice().reverse();
            const loaded = new Engine(
                order.map((sheet) =>
                    source({
                        ...sheet,
                        cells: sheet.cells.map((cell) => ({
                            ...cell,
                            value: cell.formula === null ? cell.value : null,
                        })),
                    }),
                ),
                0,
                0,
                false,
            );
            if (order !== held) for (const [place, sheet] of held.entries()) loaded.moveSheet(sheet.id, place);
            loaded.recalc(NO_CAP);
            const again = JSON.stringify(read(loaded));
            if (again !== walked) fail(`a fresh load differs:\n${again}\n${walked}`);
            counts.loads += 1;
            return walked;
        };
        const restore = (rewrites: readonly Rewrite[]) => {
            for (const { sheet, top, left, bottom, right, lost } of rewrites) {
                if (lost === null) fail('a rewrite of a sheet edit that lost nothing');
                else engine.fillFormula(sheet, top, left, bottom, right, lost);
                counts.lost += 1;
            }
        };
        const entered = (text: string) => {
            const tree = parseStored(text);
            if ('reason' in tree) return;
            let names = false;
            leaves(tree, (leaf) => {
                if (leaf.sheetKind === SheetKind.Name && !free(leaf.sheet)) names = true;
            });
            if (names) counts.bound += 1;
        };

        const cellAt = (id: string, row: number, column: number) => ({
            formula: engine.formulaOf(id, row, column),
            value: engine.valueOf(id, row, column),
        });
        const write = (): Edit => {
            const { id } = one(sheets);
            const row = pick(ROWS);
            const column = pick(COLUMNS);
            const text = formula();
            const width = pick(4) === 0 ? 2 : 1;
            return () => {
                const held = [cellAt(id, row, column), cellAt(id, row, column + 1)].slice(0, width);
                log.push(`write ${id} ${row},${column} ${width} ${text}`);
                entered(text);
                if (width === 2) engine.fillFormula(id, row, column, row, column + 1, text);
                else engine.setFormula(id, row, column, text);
                counts.writes += 1;
                return () => {
                    held.forEach((was, across) => {
                        if (was.formula !== null) engine.setFormula(id, row, column + across, was.formula);
                        else if (was.value !== null) engine.setValue(id, row, column + across, was.value);
                        else engine.clear(id, row, column + across);
                    });
                };
            };
        };
        const rename = (): Edit => {
            const sheet = one(sheets);
            const was = sheet.name;
            const cased = was.toUpperCase() === was ? was.toLowerCase() : was.toUpperCase();
            const name = pick(4) === 0 && sheetNameKey(cased) === sheetNameKey(was) ? cased : names();
            return () => {
                log.push(`rename ${sheet.id} ${name}`);
                const { rewrites } = engine.renameSheet(sheet.id, name);
                sheet.name = name;
                counts.renames += 1;
                return () => {
                    engine.renameSheet(sheet.id, was);
                    sheet.name = was;
                    restore(rewrites);
                };
            };
        };
        const remove = (): Edit => {
            const place = pick(sheets.length);
            return () => {
                const gone = read(engine)[place];
                log.push(`remove ${gone.id}`);
                engine.removeSheet(gone.id);
                const kept = sheets;
                sheets = sheets.filter((sheet) => sheet.id !== gone.id);
                counts.removes += 1;
                return () => {
                    const { rewrites } = engine.addSheet(source(gone), place);
                    if (rewrites.length > 0) fail('a sheet that came back as it went rewrote a formula');
                    sheets = kept;
                };
            };
        };
        const add = (): Edit => {
            const id = IDS.find((candidate) => sheets.every((sheet) => sheet.id !== candidate)) ?? '';
            const added = { id, name: names(), cells: content() };
            const place = pick(sheets.length + 1);
            return () => {
                log.push(`add ${place} ${JSON.stringify(added)}`);
                const kept = sheets;
                sheets = sheets.slice();
                sheets.splice(place, 0, { id, name: added.name });
                for (const cell of added.cells) if (cell.formula !== null) entered(cell.formula);
                const { rewrites } = engine.addSheet(source(added), place);
                for (const rewrite of rewrites) if (rewrite.sheet === id) fail('a rewrite on the sheet that came');
                counts.adds += 1;
                return () => {
                    engine.removeSheet(id);
                    sheets = kept;
                    restore(rewrites);
                };
            };
        };

        let before = check();
        for (let step = 0; step < steps; step += 1) {
            const drawn = pick(8);
            const edit =
                drawn < 3
                    ? write()
                    : drawn < 5
                      ? rename()
                      : drawn === 5
                        ? sheets.length > 1
                            ? remove()
                            : write()
                        : sheets.length < IDS.length
                          ? add()
                          : write();
            const undo = edit();
            counts.steps += 1;
            // Taken back before a recalc, after one, and after a reader loaded what the edit left.
            const between = pick(3);
            if (between > 0) engine.recalc(NO_CAP);
            if (between > 1) check();
            log.push('undo');
            undo();
            engine.recalc(NO_CAP);
            const after = check();
            if (after !== before) fail(`the undo left another workbook:\n${after}\n${before}`);
            counts.undone += 1;
            // The edit again, to stay: the next step meets another workbook.
            if (pick(2) === 0) continue;
            log.push('again');
            edit();
            engine.recalc(NO_CAP);
            before = check();
        }
        counts.workbooks += 1;
    }
    return counts;
}
