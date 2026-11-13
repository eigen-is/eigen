// The formula graph: which cells hold a formula, and for each cell the formulas that read it. A reader builds one from
// its sheets and keeps it while it applies batches, such as the replay over a log or the editor over its edits, so a
// row or column op costs what it moves: each formula keeps its key as the op moves its cell, and only a formula whose
// text the op rewrote lists its references again. A rename, add or delete of a sheet changes what a name reads, so the
// holder builds a new graph. The recompute walks it in affected, under the budgets an untrusted workbook is held to.

import { GONE, mapIndex } from '@workspace/formula/text';
import type { CellMatrix } from '@workspace/lib/sheets';
import type { Patch } from 'immer';
import { getCalculationOrder } from './dependency-graph';
import { cellsOf, DependencyIndex, packCell } from './dependency-index';
import { assertBeforeDeadline } from './formula-engine';
import { walkFormulaRefs } from './formula-shift';
import type { WalkContext } from './formula-utils';
import { isFormula, matrixWidth, resolveCellRange } from './formula-utils';
import { sheetFinder } from './parser/helper/cell';
import type { RecalcBudgets } from './recalc';
import type { DeleteRowColOp, InsertRowColOp } from './rowcol';
import { editOf } from './rowcol';
import type { FormulaCellInfo, FormulaCellInfoMap, FormulaDependency } from './types';

// A sheet's dense `data`, by id, which a pass reads and writes.
export type WorkingSheet = { id: string; name: string; data?: CellMatrix | null };

export type CellAt = Pick<FormulaCellInfo, 'r' | 'c' | 'id'>;

type SheetExtent = { rows: number; columns: number };

export class FormulaGraph {
    // Every formula by its key, which stays with it while row and column ops move its cell.
    private nodes: FormulaCellInfoMap = {};
    private index = new DependencyIndex();
    private readonly cells = new Map<string, Map<number, FormulaCellInfo>>();
    private readonly extents = new Map<string, SheetExtent>();
    // By sheet, the formulas with a range cut to its bounds, which list again when the bounds change. One that no
    // longer has such a range is dropped when they next change.
    private readonly cut = new Map<string, Set<FormulaCellInfo>>();
    private readonly budgets: RecalcBudgets;
    private walk: WalkContext = { findSheet: () => undefined, cellTextToIndexList: {} };
    private nextKey = 0;

    // Throws a RangeError when the formulas' ranges take more slots than the budget allows.
    public constructor(sheets: readonly WorkingSheet[], budgets: RecalcBudgets = {}) {
        this.budgets = budgets;
        this.build(sheets);
    }

    public get formulas(): Readonly<FormulaCellInfoMap> {
        return this.nodes;
    }

    public formulaAt(id: string, r: number, c: number): FormulaCellInfo | undefined {
        return this.cells.get(id)?.get(packCell(r, c));
    }

    // Records what one cell holds now: a formula, which lists the cells it reads, or none.
    public set(id: string, r: number, c: number, formula: string | null | undefined): void {
        const node = this.formulaAt(id, r, c);
        if (node?.formula === formula) return;
        if (!isFormula(formula)) {
            if (node) this.remove(node);
            return;
        }
        if (node) {
            node.formula = formula;
            this.list(node);
            return;
        }
        const added: FormulaCellInfo = { formula, key: `f${this.nextKey}`, r, c, id };
        this.nextKey += 1;
        this.nodes[added.key] = added;
        this.cellsOn(id).set(packCell(r, c), added);
        this.list(added);
    }

    // Follows a row or column op, given the sheets it left: the formulas on its sheet move with their cells, one on a
    // deleted line goes, and one whose text the op rewrote lists its references again.
    public shift(sheets: readonly WorkingSheet[], op: InsertRowColOp | DeleteRowColOp): void {
        const edit = editOf(op);
        const moved = new Map<number, FormulaCellInfo>();
        for (const node of this.cells.get(op.id)?.values() ?? []) {
            const line = mapIndex(edit, op.type === 'row' ? node.r : node.c);
            if (line === GONE) {
                delete this.nodes[node.key];
                this.index.delete(node.key);
                continue;
            }
            if (op.type === 'row') node.r = line;
            else node.c = line;
            moved.set(packCell(node.r, node.c), node);
        }
        this.cells.set(op.id, moved);

        // The op rewrote the references it moved, so the ones resolved before it are seldom read again.
        this.walk = { ...this.walk, cellTextToIndexList: {} };
        const data = new Map(sheets.map((sheet) => [sheet.id, sheet.data]));
        for (const node of Object.values(this.nodes)) {
            const formula = data.get(node.id)?.[node.r]?.[node.c]?.f;
            if (formula !== node.formula) this.set(node.id, node.r, node.c, formula);
        }
    }

    // Follows cell writes, given the sheets they left, each path starting at its sheet's index. A write that moves the
    // cells after it, such as a whole row or an added cell, reads its sheet again; one of a whole sheet builds anew.
    public followPatches(sheets: readonly WorkingSheet[], patches: readonly Patch[]): void {
        const reread = new Set<WorkingSheet>();
        for (const { op, path } of patches) {
            const [i, field, r, c] = path;
            const sheet = typeof i === 'number' ? sheets[i] : undefined;
            if (sheet == null || field == null) {
                this.build(sheets);
                return;
            }
            if (field !== 'data') continue;
            const cellWrite = typeof r === 'number' && typeof c === 'number' && (op === 'replace' || path.length > 4);
            if (cellWrite) this.set(sheet.id, r, c, sheet.data?.[r]?.[c]?.f);
            else reread.add(sheet);
        }
        for (const sheet of reread) {
            for (const node of [...this.cellsOn(sheet.id).values()]) this.remove(node);
            this.read(sheet);
        }
    }

    // Every formula that reads one of `cells`, the `chosen` ones and their readers in turn, each after what it reads.
    // Visits are counted as a formula joins, before any scan, so a walk past a budget throws early.
    public affected(
        sheets: readonly WorkingSheet[],
        cells: readonly CellAt[],
        chosen: readonly FormulaCellInfo[] = [],
    ): FormulaCellInfo[] {
        this.fit(sheets);
        const { maxDependencyVisits = Number.POSITIVE_INFINITY, maxDependencyEdges = Number.POSITIVE_INFINITY } =
            this.budgets;
        let visits = 0;
        let edges = 0;
        const visit = ({ id, r, c }: CellAt) => {
            visits += this.index.lookupVisits(id, r, c);
            if (visits > maxDependencyVisits) throw new RangeError('Formula references past the visit budget');
            assertBeforeDeadline(this.budgets.deadline);
        };
        const affected = new Set<FormulaCellInfo>();
        const join = (node: FormulaCellInfo) => {
            if (affected.has(node)) return;
            visit(node);
            affected.add(node);
        };
        const link = ({ id, r, c }: CellAt) => {
            const keys = this.index.dependentsOf(id, r, c);
            edges += keys.length;
            if (edges > maxDependencyEdges) throw new RangeError('Formula references past the edge budget');
            const linked = keys.map((key) => this.nodes[key]);
            for (const node of linked) join(node);
            return linked;
        };
        for (const node of chosen) join(node);
        for (const cell of cells) {
            visit(cell);
            link(cell);
        }
        const readers = new Map<FormulaCellInfo, FormulaCellInfo[]>();
        for (const node of affected) readers.set(node, link(node));
        return getCalculationOrder([...affected], readers);
    }

    private build(sheets: readonly WorkingSheet[]): void {
        this.nodes = {};
        this.index = new DependencyIndex();
        this.cells.clear();
        this.extents.clear();
        this.cut.clear();
        // The finder keeps names and ids only, so the graph holds no sheet's cells.
        this.walk = { findSheet: sheetFinder(sheets.map(({ id, name }) => ({ id, name }))), cellTextToIndexList: {} };
        for (const { id, data } of sheets) this.extents.set(id, extentOf(data));
        for (const sheet of sheets) this.read(sheet);
    }

    private read({ id, data }: WorkingSheet): void {
        for (let r = 0; r < (data?.length ?? 0); r += 1) {
            const row = data?.[r];
            for (let c = 0; c < (row?.length ?? 0); c += 1) {
                const formula = row?.[c]?.f;
                if (isFormula(formula)) this.set(id, r, c, formula);
            }
        }
    }

    private remove(node: FormulaCellInfo): void {
        delete this.nodes[node.key];
        this.cells.get(node.id)?.delete(packCell(node.r, node.c));
        this.index.delete(node.key);
    }

    // Lists every reference in the formula's text, as Excel lists precedents, each cut to its sheet's bounds and the
    // line past them, where a delete of the sheet's last lines seeds the readers of what it took.
    private list(node: FormulaCellInfo): void {
        const listed: FormulaDependency[] = [];
        walkFormulaRefs(node.formula, (reference) => {
            const range = resolveCellRange(this.walk, reference, node.id);
            const cells = range && cellsOf(range);
            const extent = cells && this.extents.get(cells.sheetId);
            if (cells == null || extent == null) return reference;
            const r1 = Math.min(extent.rows, cells.r1);
            const c1 = Math.min(extent.columns, cells.c1);
            if (r1 < cells.r1 || c1 < cells.c1) {
                this.cut.set(cells.sheetId, (this.cut.get(cells.sheetId) ?? new Set()).add(node));
            }
            if (cells.r0 <= r1 && cells.c0 <= c1) {
                listed.push({ row: [cells.r0, r1], column: [cells.c0, c1], sheetId: cells.sheetId });
            }
            return reference;
        });
        this.index.set(node.key, listed);
        if (this.index.slots > (this.budgets.maxDependencySlots ?? Number.POSITIVE_INFINITY)) {
            throw new RangeError('Formula ranges past the dependency budget');
        }
        assertBeforeDeadline(this.budgets.deadline);
    }

    // A sheet whose bounds changed lists again the formulas whose ranges its old bounds cut.
    private fit(sheets: readonly WorkingSheet[]): void {
        for (const { id, data } of sheets) {
            const extent = this.extents.get(id);
            if (extent == null) continue;
            const now = extentOf(data);
            if (now.rows === extent.rows && now.columns === extent.columns) continue;
            this.extents.set(id, now);
            const cut = [...(this.cut.get(id) ?? [])];
            this.cut.delete(id);
            for (const node of cut) {
                if (this.nodes[node.key] === node) this.list(node);
            }
        }
    }

    private cellsOn(id: string): Map<number, FormulaCellInfo> {
        let cells = this.cells.get(id);
        if (cells == null) {
            cells = new Map();
            this.cells.set(id, cells);
        }
        return cells;
    }
}

// A sheet's rows and columns, each rounded up by at most an eighth, so a row op that grows or shrinks the sheet by a
// line seldom lists its cut formulas again.
function extentOf(data: CellMatrix | null | undefined): SheetExtent {
    const bound = (n: number) => {
        const step = 2 ** Math.max(0, Math.floor(Math.log2(n)) - 3);
        return Math.ceil(n / step) * step;
    };
    return data ? { rows: bound(data.length), columns: bound(matrixWidth(data)) } : { rows: 0, columns: 0 };
}
