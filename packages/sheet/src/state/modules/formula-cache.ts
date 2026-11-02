// The editor's formula bookkeeping: FormulaCache, the per-workbook state of the formula engine and the reference
// picker, the map of which cells hold formulas and which cells each one reads, and the resolver that lets the engine
// read cells from the live context. setFormulaCellInfo keeps the map in step with each write, through the dependency
// walk the server's recalc uses too, and an undo or redo replays its patches.

import { current, isDraft } from 'immer';
import { findSheetByName } from '../../engine/a1-notation';
import type { DependencyIndex, SheetExtent } from '../../engine/dependency-index';
import { FormulaEngine } from '../../engine/formula-engine';
import { matrixWidth } from '../../engine/formula-utils';
import { extractDependencies } from '../../engine/recalc';
import type {
    CalcChainEntry,
    Cell,
    CellMatrix,
    CellResolver,
    FormulaCellInfo,
    FormulaCellInfoMap,
    FormulaDependency,
} from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, History, Selection } from '../types';
import { getSheetIdByName } from '../utils';
import { getcellFormula } from './cell';
import { execfunction, warmFormulaCellInfoMap } from './formula-exec';

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

// A plain copy of the context, not an immer draft. Evaluation reads cells one at a time. Each read through a draft is
// several times slower, and it makes child drafts that immer must walk when the recipe ends.
export function snapshotContext(ctx: Context): Context {
    return isDraft(ctx) ? current(ctx) : ctx;
}

// The CellResolver through which the FormulaEngine reads the editor's cells. It reads the context it is handed. A pass
// in dependency order takes `snapshotContext(ctx)`: the values it computes reach the next formula through
// execFunctionGlobalData, which the engine reads before the cells. A sweep that writes between evaluations, such as
// calculateFormula's, takes the live ctx, so each evaluation sees the writes before it.
export function createContextResolver(source: Context): CellResolver {
    const matrices = new Map<string, CellMatrix | null>();
    const dataFor = (sheetId: string) => {
        let matrix = matrices.get(sheetId);
        if (matrix === undefined) {
            matrix = getFlowdata(source, sheetId) ?? null;
            matrices.set(sheetId, matrix);
        }
        return matrix;
    };

    return {
        getCell(sheetId: string, row: number, col: number) {
            return dataFor(sheetId)?.[row]?.[col] ?? null;
        },
        getSheetIdByName(name: string) {
            return getSheetIdByName(source, name) ?? null;
        },
        getSheetData(sheetId: string) {
            return dataFor(sheetId);
        },
        getSheets() {
            return source.sheets.map((f) => ({
                id: f.id,
                name: f.name,
                calculationChain: f.calcChain ?? [],
                dynamicArrayCompute: f.dynamicArray_compute ?? [],
            }));
        },
    };
}

// A class, because immer freezes the plain objects of a context but leaves a class instance alone, and the editor
// writes the cache outside a recipe.
export class FormulaCache {
    // The reference picker's state and the caches only the editor keeps. The engine holds what the server shares.
    public func_selectedrange?: Selection;

    public cellTextToIndexList: Record<string, FormulaDependency>;

    // Each sheet's size, by id, which the dependency index lists ranges by. Measuring a sheet scans its rows, so it is
    // kept as long as the resolved references, which a change to a grid's size resets too.
    public sheetExtents = new Map<string, SheetExtent>();

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

    public execFunctionExist?: CalcChainEntry[];

    // The cells an edit changed, which deleteSelectedCellText sets. runExecFunction then recomputes only these, not
    // every cell of the selection, so clearing a large and mostly empty selection stays cheap.
    public pendingChangedCells?: CalcChainEntry[];

    public engine: FormulaEngine;

    public constructor() {
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.cellTextToIndexList = {};
        this.engine = new FormulaEngine();
    }

    // The engine keeps these, so the editor and the server read one cache.
    public get execFunctionGlobalData(): Record<string, Cell> {
        return this.engine.state.execFunctionGlobalData;
    }

    public set execFunctionGlobalData(v: Record<string, Cell> | null | undefined) {
        this.engine.state.execFunctionGlobalData = v ?? {};
    }

    public get formulaCellInfoMap(): FormulaCellInfoMap | null {
        return this.engine.state.formulaCellInfoMap;
    }

    public set formulaCellInfoMap(v: FormulaCellInfoMap | null) {
        this.engine.state.formulaCellInfoMap = v;
        // Code assigns the map only to reset it, such as after a row insert or a sheet rename. The reverse index mirrors
        // the map, so it resets too. The resolved references and the sheet sizes go as well, because they hold the
        // sheets' old sizes and names. setFormulaCellInfo fills them all again.
        this.engine.state.dependencyIndex.clear();
        this.cellTextToIndexList = {};
        this.sheetExtents.clear();
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
        this.sheetExtents.clear();
    }

    public updateFormulaCache(ctx: Context, history: History, type: 'undo' | 'redo') {
        const patches = type === 'undo' ? history.inversePatches : history.patches;
        // A renamed sheet changes which sheet a sheet name reads, so the map is built again on next use. The reset
        // also drops the references other callers resolved, which matters even when no map is built yet.
        if (patches.some(({ path }) => path[0] === 'sheets' && path[2] === 'name')) {
            this.formulaCellInfoMap = null;
            return;
        }
        // An unbuilt map reads the patched cells when it builds.
        const map = this.formulaCellInfoMap;
        if (map == null) return;

        // Every formula change carries a `data` patch, so the map follows those.
        for (const patch of patches) {
            const [root, sheetIndex, field, r, c, cellField] = patch.path;
            if (root !== 'sheets' || (field != null && field !== 'data')) continue;
            const id = typeof sheetIndex === 'number' ? ctx.sheets[sheetIndex]?.id : undefined;
            // A patch that adds or drops a sheet, a whole matrix, a row or a cell makes the map build again on next use.
            // Adding or dropping a row or a cell resizes the grid, which moves where a whole column or row ends.
            const resized = cellField == null && patch.op !== 'replace';
            if (id == null || typeof r !== 'number' || (c != null && typeof c !== 'number') || resized) {
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
    const formulaCellInfoMap = warmFormulaCellInfoMap(ctx, dataSheet === ctx.currentSheetId ? data : undefined);
    const key = `r${formulaCell.r}c${formulaCell.c}i${formulaCell.id}`;
    const cellData = formulaCell.id === dataSheet ? data : undefined;
    const formula = getcellFormula(ctx, formulaCell.r, formulaCell.c, formulaCell.id, cellData);
    if (formula == null) {
        delete formulaCellInfoMap[key];
        ctx.formulaCache.dependencyIndex.delete(key);
        return;
    }
    // The server's recalc finds the cells a formula reads with this same walk. The editor keeps its cache of resolved
    // references from one edit to the next.
    const formulaDependency = extractDependencies(
        {
            sheets: ctx.sheets,
            findSheet: (name) => findSheetByName(ctx.sheets, name),
            cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
        },
        formula,
        formulaCell.id,
        cellData ?? getFlowdata(ctx, formulaCell.id),
    );

    formulaCellInfoMap[key] = {
        formulaDependency,
        calc_funcStr: formula,
        key,
        r: formulaCell.r,
        c: formulaCell.c,
        id: formulaCell.id,
        parents: {},
        children: {},
        color: 'w',
    };
    const { sheetExtents } = ctx.formulaCache;
    ctx.formulaCache.dependencyIndex.set(key, formulaDependency, (sheetId) => {
        let extent = sheetExtents.get(sheetId);
        if (extent === undefined) {
            const matrix = getFlowdata(ctx, sheetId);
            if (matrix == null) return undefined;
            extent = { rows: matrix.length, columns: matrixWidth(matrix) };
            sheetExtents.set(sheetId, extent);
        }
        return extent;
    });
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
    for (let r = 0; r < data.length; r += 1) {
        for (let c = 0; c < data[r].length; c += 1) {
            if (data[r][c]?.f != null) setFormulaCellInfo(ctx, { r, c, id }, data, id);
        }
    }
}

export function executeAffectedFormulas(
    ctx: Context,
    formulaRunList: FormulaCellInfo[],
    calcChains: FormulaCell[],
    resolver: CellResolver,
) {
    const calcChainSet = new Set<string>();
    for (const item of calcChains) {
        calcChainSet.add(`${item.r}_${item.c}_${item.id}`);
    }

    // The results are collected here and assigned once. ctx is usually an immer draft, and each push through it would
    // record a patch.
    const refreshed: Context['groupValuesRefreshData'] = [];

    for (let i = 0; i < formulaRunList.length; i += 1) {
        const formulaCell = formulaRunList[i];
        const { calc_funcStr } = formulaCell;

        const v = execfunction(
            ctx,
            calc_funcStr,
            formulaCell.r,
            formulaCell.c,
            formulaCell.id,
            calcChainSet,
            undefined,
            undefined,
            resolver,
        );

        refreshed.push({
            r: formulaCell.r,
            c: formulaCell.c,
            v: v[1],
            f: v[2],
            id: formulaCell.id,
        });

        ctx.formulaCache.execFunctionGlobalData[`${formulaCell.r}_${formulaCell.c}_${formulaCell.id}`] = {
            v: v[1],
            f: v[2],
        };
    }

    ctx.groupValuesRefreshData =
        ctx.groupValuesRefreshData.length > 0 ? ctx.groupValuesRefreshData.concat(refreshed) : refreshed;
}
