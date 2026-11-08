// The editor's formula bookkeeping: FormulaCache, the per-workbook state of the formula engine and the reference
// picker, and the map of which cells hold formulas and which cells each one reads. setFormulaCellInfo keeps the map in
// step with each write, through the dependency walk the server's recalc uses too, and an undo or redo replays its
// patches.

import type { Patch } from 'immer';
import { current, isDraft } from 'immer';
import { findSheetByName } from '../../engine/a1-notation';
import type { DependencyIndex } from '../../engine/dependency-index';
import { FormulaEngine } from '../../engine/formula-engine';
import { isFormula } from '../../engine/formula-utils';
import { extractDependencies } from '../../engine/recalc';
import type { Cell, CellMatrix, FormulaCellInfoMap, FormulaDependency } from '../../engine/types';
import type { Context } from '../context';
import type { FormulaCell, Selection } from '../types';
import { getcellFormula } from './cell';
import { warmFormulaCellInfoMap } from './formula-exec';

// The formula editor's hint and range state, which several modules of the formula editor share. It sits in an object,
// so a write in one module is seen by the others.
export const formulaUIState: { functionHTMLIndex: number; rangeIndexes: number[] } = {
    functionHTMLIndex: 0,
    rangeIndexes: [],
};

export function setFunctionHTMLIndex(value: number) {
    formulaUIState.functionHTMLIndex = value;
}

export function resetFunctionHTMLIndex() {
    formulaUIState.functionHTMLIndex = 0;
}

export function setRangeIndexes(value: number[]) {
    formulaUIState.rangeIndexes = value;
}

export function resetRangeIndexes() {
    formulaUIState.rangeIndexes = [];
}

// A plain copy of the context, not an immer draft: each cell read through a draft is slower and makes child drafts.
// A sweep that writes between evaluations, such as a paste's, resolves over the live sheets instead.
export function snapshotContext(ctx: Context): Context {
    return isDraft(ctx) ? current(ctx) : ctx;
}

// A class, because immer freezes the plain objects of a context but leaves a class instance alone, and the editor
// writes the cache outside a recipe.
export class FormulaCache {
    // The reference picker's state and the caches only the editor keeps. The engine holds what the server shares.
    public func_selectedrange?: Selection;

    public cellTextToIndexList: Record<string, FormulaDependency>;

    public rangechangeindex?: number;

    public selectingRangeIndex: number;

    public rangeResizeTo?: HTMLDivElement[];

    public rangeSetValueTo?: Node | null;

    public rangeIndex?: number;

    public rangestart?: boolean;

    public rangetosheet?: string;

    public rangedrag_column_start?: boolean;

    public rangedrag_row_start?: boolean;

    public functionRangeIndex?: number[];

    public functionlistMap: Record<string, unknown>;

    public engine: FormulaEngine;

    public constructor() {
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.cellTextToIndexList = {};
        this.engine = new FormulaEngine();
    }

    public get formulaCellInfoMap(): FormulaCellInfoMap | null {
        return this.engine.state.formulaCellInfoMap;
    }

    public set formulaCellInfoMap(v: FormulaCellInfoMap | null) {
        this.engine.state.formulaCellInfoMap = v;
        // The map is assigned only to reset it, so the reverse index and the resolved references, which hold the
        // sheets' old names, reset with it. setFormulaCellInfo fills them all again.
        this.engine.state.dependencyIndex.clear();
        this.cellTextToIndexList = {};
    }

    // For each cell, the formulas that read it. It lives in the engine's state next to the formula map, so a new
    // engine starts both empty. setFormulaCellInfo and the map's setter keep the two in step.
    public get dependencyIndex(): DependencyIndex {
        return this.engine.state.dependencyIndex;
    }

    // Forgets what the engine learned from the cells, for sheets swapped under it. The reference picker's state stays.
    public resetEngine() {
        this.engine = new FormulaEngine();
        this.cellTextToIndexList = {};
    }

    public updateFormulaCache(ctx: Context, patches: readonly Patch[]) {
        // An unbuilt map reads the patched cells when it builds.
        const map = this.formulaCellInfoMap;
        if (map == null) return;

        // Every formula change carries a `data` patch, so the map follows those.
        for (const patch of patches) {
            const [root, sheetIndex, field, r, c, cellField] = patch.path;
            if (root !== 'sheets' || (field != null && field !== 'data')) continue;
            const id = typeof sheetIndex === 'number' ? ctx.sheets[sheetIndex]?.id : undefined;
            // A patch that adds or drops a sheet or a whole matrix, or drops a row, makes the map build again on next
            // use, because no patch names the formulas that went with it.
            const droppedRow = c == null && patch.op === 'remove';
            if (id == null || typeof r !== 'number' || (c != null && typeof c !== 'number') || droppedRow) {
                this.formulaCellInfoMap = null;
                return;
            }
            if (typeof c === 'number') {
                if (cellField == null || cellField === 'f') setFormulaCellInfo(ctx, { r, c, id });
                continue;
            }
            const row: (Cell | null)[] = patch.value;
            for (let col = 0; col < row.length; col += 1) {
                if (row[col]?.f != null || map[`r${r}c${col}i${id}`] != null) {
                    setFormulaCellInfo(ctx, { r, c: col, id });
                }
            }
        }
    }
}

// Records one cell's formula in the formula map with the cells it reads, so it runs after the cell was written. `data`
// stands in for the matrix of `dataSheetId`, the current sheet by default. It is read only for a cell on that sheet: a
// cell of another sheet at the same row and column would give the wrong formula.
export function setFormulaCellInfo(ctx: Context, formulaCell: FormulaCell, data?: CellMatrix, dataSheetId?: string) {
    const dataSheet = dataSheetId ?? ctx.currentSheetId;
    // An entry written into an unbuilt map would pass for the whole map, and the build would never run.
    const formulaCellInfoMap = warmFormulaCellInfoMap(ctx);
    const key = `r${formulaCell.r}c${formulaCell.c}i${formulaCell.id}`;
    const cellData = formulaCell.id === dataSheet ? data : undefined;
    const formula = getcellFormula(ctx, formulaCell.r, formulaCell.c, formulaCell.id, cellData);
    if (!isFormula(formula)) {
        delete formulaCellInfoMap[key];
        ctx.formulaCache.dependencyIndex.delete(key);
        return;
    }
    // The server's recalc finds the cells a formula reads with this same walk. The editor keeps its cache of resolved
    // references from one edit to the next.
    const dependencies = extractDependencies(
        {
            findSheet: (name) => findSheetByName(ctx.sheets, name),
            cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
        },
        formula,
        formulaCell.id,
    );

    formulaCellInfoMap[key] = {
        formula,
        key,
        r: formulaCell.r,
        c: formulaCell.c,
        id: formulaCell.id,
        dependents: [],
    };
    ctx.formulaCache.dependencyIndex.set(key, dependencies);
}

// A sheet arriving whole carries no cell patches; an unbuilt map reads it when it builds.
export function registerSheetFormulas(ctx: Context, id: string, data: CellMatrix) {
    const map = ctx.formulaCache.formulaCellInfoMap;
    if (map == null) return;
    for (const key of Object.keys(map)) {
        if (map[key].id !== id) continue;
        delete map[key];
        ctx.formulaCache.dependencyIndex.delete(key);
    }
    registerFormulas(ctx, id, data);
}

// Records every formula one sheet's matrix holds. A cell's `f` is the one record of which cells hold a formula.
export function registerFormulas(ctx: Context, id: string, data: CellMatrix) {
    for (let r = 0; r < data.length; r += 1) {
        const row = data[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c += 1) {
            if (isFormula(row[c]?.f)) setFormulaCellInfo(ctx, { r, c, id }, data, id);
        }
    }
}
