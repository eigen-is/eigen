// The editor's formula bookkeeping: FormulaCache, the per-workbook state of the formula engine and the reference
// picker, and the formula graph of which cells hold formulas and which cells each one reads. setFormulaCellInfo keeps
// the graph in step with each write, and an undo, a redo or a peer's batch has it follow its patches.

import type { Patch } from 'immer';
import { current, isDraft } from 'immer';
import { FormulaEngine } from '../../engine/formula-engine';
import type { FormulaGraph } from '../../engine/formula-graph';
import type { CellMatrix, FormulaDependency } from '../../engine/types';
import type { Context } from '../context';
import type { FormulaCell, Selection } from '../types';
import { getcellFormula } from './cell';

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
    // The reference picker's state and the caches only the editor keeps.
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

    // Built on first use, and kept through edits and row and column ops.
    public graph: FormulaGraph | null = null;

    public constructor() {
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.cellTextToIndexList = {};
        this.engine = new FormulaEngine();
    }

    // A sheet's rename, add or delete changes what a name reads, so the graph and the resolved references, which hold
    // the sheets' old names, go, and the next use builds the graph again.
    public forgetGraph() {
        this.graph = null;
        this.cellTextToIndexList = {};
    }

    // Forgets what the engine learned from the cells, for sheets swapped under it. The reference picker's state stays.
    public resetEngine() {
        this.engine = new FormulaEngine();
        this.forgetGraph();
    }

    // Has the graph follow the patches an undo, a redo or a peer's batch wrote, once they applied to `ctx`. An unbuilt
    // graph reads the patched cells when it builds.
    public followPatches(ctx: Context, patches: readonly Patch[]) {
        const onSheets = patches.flatMap((patch) =>
            patch.path[0] === 'sheets' ? [{ ...patch, path: patch.path.slice(1) }] : [],
        );
        if (onSheets.length > 0) this.graph?.followPatches(snapshotContext(ctx).sheets, onSheets);
    }
}

// Records one cell's formula in the formula graph, so it runs after the cell was written. `data` stands in for the
// matrix of `dataSheetId` and is read only for a cell on that sheet: another sheet's cell there would give the wrong
// formula. A graph built later reads the cell itself.
export function setFormulaCellInfo(ctx: Context, formulaCell: FormulaCell, data?: CellMatrix, dataSheetId?: string) {
    const dataSheet = dataSheetId ?? ctx.currentSheetId;
    const cellData = formulaCell.id === dataSheet ? data : undefined;
    const formula = getcellFormula(ctx, formulaCell.r, formulaCell.c, formulaCell.id, cellData);
    ctx.formulaCache.graph?.set(formulaCell.id, formulaCell.r, formulaCell.c, formula);
}
