// How a peer's batch changes this tab's pending undos. Any batch ends your own structural entries, such as a row op, a
// rename or a paste that grew the grid, and with them everything older (dropStructuralEntries). A row or column op then
// moves what is left, the cell and field entries: shiftEntries moves their paths and values as the op moves the live
// sheets, so an undo lands where its cell now is. The Workbook's applyOp runs both, and a RowColMove also moves the
// open editor and the selection along an op.

import type { Edit } from '@workspace/formula/text';
import { GONE, mapIndex } from '@workspace/formula/text';
import type { ConditionalFormatRule, MergeCell, SheetChart } from '@workspace/lib/sheets';
import type { Patch } from 'immer';
import { sheetFinder } from '../../engine/a1-notation';
import { mapChartRefs } from '../../engine/chart-data';
import { functionStrChange, mayShiftOffSheet } from '../../engine/formula-shift';
import { isFormula } from '../../engine/formula-utils';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    editOf,
    LINE_MAPS,
    shiftCellKeyed,
    shiftKeyedMap,
    shiftMerges,
    shiftRange,
    shiftRules,
} from '../../engine/rowcol';
import type { Cell } from '../../engine/types';
import type { History, Sheet } from '../types';

// One row or column op: the sheet and axis it names, its edit of that axis's lines, and its rewrite of a formula.
export type RowColMove = {
    id: string;
    type: 'row' | 'column';
    edit: Edit;
    formula: (
        text: string,
        sheetName: string,
        onTargetSheet: boolean,
        findSheet: (name: string) => Sheet | undefined,
    ) => string;
};

export function insertMove(op: InsertRowColOp): RowColMove {
    const { id, type, index, count, direction } = op;
    return {
        id,
        type,
        edit: editOf(op),
        formula: (text, name, onTargetSheet, findSheet) =>
            functionStrChange(text, 'add', axisName(type), direction, index, count, name, onTargetSheet, findSheet),
    };
}

export function deleteMove(op: DeleteRowColOp): RowColMove {
    const { id, type, start, end } = op;
    const count = end - start + 1;
    return {
        id,
        type,
        edit: editOf(op),
        formula: (text, name, onTargetSheet, findSheet) =>
            functionStrChange(text, 'del', axisName(type), null, start, count, name, onTargetSheet, findSheet),
    };
}

// A structural entry records the workbook it found and left, so it can only step on that workbook. Each entry below it
// fits the workbook as it leaves it, so those go too, on the undo and the redo stack alike.
export function dropStructuralEntries(entries: readonly History[]): History[] {
    return entries.slice(entries.findLastIndex(isStructural) + 1);
}

function isStructural(entry: History): boolean {
    return (
        namesStructuralOp(entry) || entry.patches.some(writesListLength) || entry.inversePatches.some(writesListLength)
    );
}

// A row, column or sheet op, as opposed to an edit that ships its own patches.
export function namesStructuralOp({ options }: History): boolean {
    return Boolean(
        options.insertRowColOp ||
            options.deleteRowColOp ||
            options.addedSheet ||
            options.deletedSheet ||
            options.renamedSheet,
    );
}

// Immer records a list that grew or shrank as a write of its `length`, and stepping that back cuts off what a peer
// appended. A list inside one target, such as a rule's ranges, is that target's write.
function writesListLength({ path }: Patch): boolean {
    return path.at(-1) === 'length' && path.length === unitOf(path).length;
}

// A cell, a config map's entry, or one rule, image or chart: what a peer's write and yours collide on.
export function unitOf(path: (string | number)[]) {
    return path.slice(0, path[2] === 'data' || path[2] === 'config' ? 5 : 4);
}

// A peer's row or column op moves your entries on its sheet, and the formula text that points at it on any sheet. An
// entry the op makes meaningless is dropped, such as one that writes inside deleted rows or cuts a merge.
export function shiftEntries(entries: History[], move: RowColMove, sheets: readonly Sheet[]): History[] {
    const target = sheets.find((sheet) => sheet.id === move.id);
    if (!target) return entries;
    const shifter = new Shifter(move, target.name, sheets);
    return entries.flatMap((entry) => shifter.entry(entry) ?? []);
}

function axisName(type: 'row' | 'column') {
    return type === 'row' ? 'row' : 'col';
}

// Shifts one entry for a peer's row or column op.
class Shifter {
    private readonly move: RowColMove;
    private readonly name: string;
    private readonly sheets: readonly Sheet[];
    private readonly findSheet: (name: string) => Sheet | undefined;
    private readonly mayShift: (txt: string) => boolean;

    public constructor(move: RowColMove, name: string, sheets: readonly Sheet[]) {
        this.move = move;
        this.name = name;
        this.sheets = sheets;
        this.findSheet = sheetFinder(sheets);
        this.mayShift = mayShiftOffSheet(name);
    }

    public entry(entry: History): History | null {
        const patches = this.patches(entry.patches);
        const inversePatches = this.patches(entry.inversePatches);
        return patches && inversePatches && { ...entry, patches, inversePatches };
    }

    private patches(patches: Patch[]): Patch[] | null {
        const shifted: Patch[] = [];
        for (const patch of patches) {
            const next = this.patch(patch);
            if (!next) return null;
            shifted.push(next);
        }
        return shifted;
    }

    private patch(patch: Patch): Patch | null {
        const [, sheet, field, ...rest] = patch.path;
        if (field === 'charts') return this.chartNamesSheet(patch) ? null : patch;
        if (field === 'conditionalFormats' && this.rewritesRule(patch.value, sheet === this.move.id)) return null;
        if (sheet !== this.move.id) return field === 'data' ? this.otherSheetData(patch, rest.length) : patch;
        if (field === 'data') return this.dataPatch(patch, rest);
        if (field === 'config') return this.configPatch(patch, rest);
        if (field === 'dataValidations' || field === 'conditionalFormats') return this.rule(patch, rest);
        return POSITION_FREE_FIELDS.has(field) ? patch : null;
    }

    // A cell or row on another sheet moves nothing but the formula text that points at the op's sheet.
    private otherSheetData(patch: Patch, depth: number): Patch {
        if (!('value' in patch)) return patch;
        const { value } = patch;
        if (depth === 1 && Array.isArray(value)) {
            return { ...patch, value: value.map((cell: Cell | null) => this.otherCell(cell)) };
        }
        if (depth === 2) return { ...patch, value: this.otherCell(value) };
        if (depth === 3 && patch.path[5] === 'f' && isFormula(value)) {
            return { ...patch, value: this.formula(value, false) };
        }
        return patch;
    }

    private otherCell(cell: Cell | null): Cell | null {
        return isFormula(cell?.f) ? { ...cell, f: this.formula(cell.f, false) } : cell;
    }

    private dataPatch(patch: Patch, [r, c, ...below]: (string | number)[]): Patch | null {
        const { type, edit } = this.move;
        const position = type === 'row' ? r : c;
        if (typeof r !== 'number' || typeof position !== 'number') return null;
        const moved = mapIndex(edit, position);
        if (moved === GONE) return null;
        const keys = c == null ? [r] : [r, c, ...below];
        keys[type === 'row' ? 0 : 1] = moved;
        const path = [...patch.path.slice(0, 3), ...keys];
        if (!('value' in patch)) return { ...patch, path };
        const value = this.cellValue(patch.value, below, position);
        return value === undefined ? null : { ...patch, path, value };
    }

    // A cell, a row of cells, or a cell's field, as the op leaves it; undefined when a merge it holds is cut.
    private cellValue(value: unknown, below: (string | number)[], position: number): unknown {
        if (below.length === 0) {
            if (Array.isArray(value)) {
                const row = value.map((cell, c) => this.cell(cell, this.move.type === 'row' ? position : c));
                return row.includes(undefined) ? undefined : row;
            }
            return isCell(value) ? this.cell(value, position) : value;
        }
        if (below.length === 1 && below[0] === 'f' && isFormula(value)) return this.formula(value, true);
        if (below.length === 1 && below[0] === 'mc' && isMergeRef(value)) return this.mergeRef(value, position);
        return value;
    }

    private cell(cell: Cell | null, position: number): Cell | null | undefined {
        if (!cell) return cell;
        let next = cell;
        if (isFormula(cell.f)) next = { ...next, f: this.formula(cell.f, true) };
        if (cell.mc) {
            const mc = this.mergeRef(cell.mc, position);
            if (!mc) return undefined;
            next = { ...next, mc };
        }
        return next;
    }

    // A merge reference moves with its cell. A cut through the merge drops the entry: the merge itself changed.
    private mergeRef(mc: MergeRef, position: number): MergeRef | undefined {
        const row = this.move.type === 'row';
        const start = row ? mc.r : mc.c;
        const span = row ? mc.rs : mc.cs;
        const ends = [start, position, ...(span ? [start + span - 1] : [])];
        const offsets = new Set(ends.map((end) => this.offset(end)));
        const [offset] = offsets;
        if (offsets.size !== 1 || offset == null) return undefined;
        return row ? { ...mc, r: mc.r + offset } : { ...mc, c: mc.c + offset };
    }

    private offset(index: number) {
        const moved = mapIndex(this.move.edit, index);
        return moved === GONE ? null : moved - index;
    }

    private configPatch(patch: Patch, [map, key, ...below]: (string | number)[]): Patch | null {
        // Every sheet the editor holds has its config maps, so only a peer's forged map leaves a write of a whole one.
        if (key == null) return null;
        const head = patch.path.slice(0, 4);
        const { type, edit } = this.move;
        if (map === 'merge') {
            if (below.length > 0 || !patch.value) return this.cellKeyed(patch, [key, ...below]);
            const [entry] = Object.entries(shiftMerges({ merge: { [key]: patch.value } }, type, edit).merges);
            if (!entry || !sameSize(entry[1], patch.value)) return null;
            return { ...patch, path: [...head, entry[0]], value: entry[1] };
        }
        if (map === 'borderInfo') return this.cellKeyed(patch, [key, ...below]);
        if (LINE_MAPS[type].some((name) => name === map)) {
            const [moved] = Object.keys(shiftKeyedMap({ [key]: 0 }, edit));
            return moved == null ? null : { ...patch, path: [...head, moved, ...below] };
        }
        return LINE_MAPS[type === 'row' ? 'column' : 'row'].some((name) => name === map) ? patch : null;
    }

    // An "r_c" key at the head of `rest`, such as a border.
    private cellKeyed(patch: Patch, [key, ...below]: (string | number)[]): Patch | null {
        if (typeof key !== 'string') return null;
        const [moved] = Object.keys(shiftCellKeyed({ [key]: true }, this.move.type, this.move.edit));
        if (moved == null) return null;
        const depth = patch.path.length - below.length - 1;
        return { ...patch, path: [...patch.path.slice(0, depth), moved, ...below] };
    }

    // A conditional format or a validation rule, whose ranges move as the engine moves the live ones. A rule the op
    // leaves with no range drops the entry, as a write into deleted rows does.
    private rule(patch: Patch, [id, ...below]: (string | number)[]): Patch | null {
        if (!('value' in patch) || patch.value == null) return patch;
        if (id == null || below.length > 0) return null;
        const { type, edit } = this.move;
        const value = shiftRules({ [id]: patch.value }, (range) => shiftRange(range, type, edit))[id];
        return value ? { ...patch, value } : null;
    }

    // The engine rewrites a formula rule's text on the op's sheet, and on any other sheet where the text names the
    // op's sheet, so an entry that holds the rule would bring back its old text.
    private rewritesRule(rule: Partial<ConditionalFormatRule> | undefined, onTargetSheet: boolean): boolean {
        if (rule?.type !== 'default' || rule.conditionName !== 'formula') return false;
        return onTargetSheet || this.mayShift(String(rule.conditionValue?.[0]));
    }

    private formula(f: string, onTargetSheet: boolean): string {
        if (!onTargetSheet && !this.mayShift(f)) return f;
        return `=${this.move.formula(f.slice(1), this.name, onTargetSheet, this.findSheet)}`;
    }

    // A chart's data follows the ranges it reads; a write to its box, its look or its style moves with nothing.
    private chartNamesSheet(patch: Patch): boolean {
        const [, sheet, , chartId, part] = patch.path;
        if (part != null && part !== 'specData') return false;
        const stored = this.sheets.find((s) => s.id === sheet)?.charts ?? {};
        const charts: (SheetChart | undefined)[] =
            chartId == null
                ? [...Object.values(stored), ...Object.values(patch.value ?? {})]
                : [stored[chartId], part == null ? patch.value : undefined];
        return charts.some((chart) => chart != null && this.names(chart));
    }

    private names(chart: SheetChart): boolean {
        let named = false;
        mapChartRefs(chart, (ref) => {
            named ||= ref.sheetId === this.move.id;
            return ref;
        });
        return named;
    }
}

// A cell's place in a merge: the merge's corner, with its size on the corner cell itself.
type MergeRef = NonNullable<Cell['mc']>;

function isCell(value: unknown): value is Cell | null {
    return value === null || (typeof value === 'object' && !Array.isArray(value));
}

function isMergeRef(value: unknown): value is MergeRef {
    return typeof value === 'object' && value !== null && 'r' in value && 'c' in value;
}

function sameSize(a: MergeCell, b: MergeCell) {
    return a.rs === b.rs && a.cs === b.cs;
}

// Sheet fields a row or column op never moves.
const POSITION_FREE_FIELDS = new Set<string | number>([
    'name',
    'color',
    'hide',
    'order',
    'showGridLines',
    'zoomRatio',
    'defaultRowHeight',
    'defaultColWidth',
    'images',
]);
