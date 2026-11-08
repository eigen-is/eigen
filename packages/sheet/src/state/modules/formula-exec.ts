// Formula execution in the editor: evaluating a cell's formula, keeping the calc chain of formula cells, and
// recomputing the cells an edit affects (execFunctionGroup). These read and write the workbook context, so they live
// in the state layer, while the parsing and evaluating they call into is the engine's.

import { current, isDraft } from 'immer';
import { findSheetByName } from '../../engine/a1-notation';
import { createArrayResolver, withComputedValues } from '../../engine/cell-resolver';
import { getCalculationOrder } from '../../engine/dependency-graph';
import { checkBracketNum, LAST_COLUMN, LAST_ROW, matrixWidth, resolveCellRange } from '../../engine/formula-utils';
import type {
    Cell,
    CellMatrix,
    CellResolver,
    FormulaCellInfo,
    FormulaCellInfoMap,
    FormulaDependency,
} from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell } from '../types';
import { getSheetIndex } from '../utils';
import { setCellValue } from './cell';
import { setFormulaCellInfo, snapshotContext } from './formula-cache';
import { error } from './validation';

// The cells a reference in the grid's UI covers, such as a link or a highlighted range: a whole column or row stops at
// its sheet's end. null when it covers none, or names a sheet with no matrix to show them on.
export function getcellrange(ctx: Context, txt: string): FormulaDependency | null {
    const range = resolveCellRange(
        {
            findSheet: (name) => findSheetByName(ctx.sheets, name),
            cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
        },
        txt,
        ctx.currentSheetId,
    );
    const data = range && getFlowdata(ctx, range.sheetId);
    if (range == null || data == null) return null;
    const lastRow = range.row[1] >= LAST_ROW ? data.length - 1 : range.row[1];
    const lastColumn = range.column[1] >= LAST_COLUMN ? matrixWidth(data) - 1 : range.column[1];
    if (lastRow < range.row[0] || lastColumn < range.column[0]) return null;
    return { row: [range.row[0], lastRow], column: [range.column[0], lastColumn], sheetId: range.sheetId };
}

export function getAllFunctionGroup(ctx: Context): FormulaCell[] {
    return ctx.sheets.flatMap((sheet) => sheet.calcChain ?? []);
}

export function delFunctionGroup(ctx: Context, r: number, c: number, id?: string): void {
    if (id == null) {
        id = ctx.currentSheetId;
    }

    const file = getSheet(ctx, { id });

    const { calcChain } = file;
    if (calcChain != null) {
        let modified = false;
        const calcChainClone = calcChain.slice();
        for (let i = 0; i < calcChainClone.length; i += 1) {
            const calc = calcChainClone[i];
            if (calc.r === r && calc.c === c && calc.id === id) {
                calcChainClone.splice(i, 1);
                modified = true;
                break;
            }
        }
        if (modified) {
            file.calcChain = calcChainClone;
        }
    }
}

export function insertUpdateFunctionGroup(
    ctx: Context,
    r: number,
    c: number,
    id?: string,
    calcChainSet?: Set<string>,
): void {
    if (id == null) {
        id = ctx.currentSheetId;
    }

    // Answer the common already-present case from the set before touching
    // ctx: during a recalc this runs once per formula, and sheet lookups on
    // an immer draft are not free.
    if (calcChainSet?.has(`${r}_${c}_${id}`)) return;

    const { sheets } = ctx;
    const idx = getSheetIndex(ctx, id);
    if (idx == null) {
        return;
    }
    const file = sheets[idx];

    let { calcChain } = file;
    if (calcChain == null) {
        calcChain = [];
    }

    if (!calcChainSet) {
        for (let i = 0; i < calcChain.length; i += 1) {
            const calc = calcChain[i];
            if (calc.r === r && calc.c === c && calc.id === id) {
                return;
            }
        }
    }

    const cc = {
        r,
        c,
        id,
    };
    calcChain.push(cc);
    file.calcChain = calcChain;
    ctx.sheets = sheets;
}

export type ExecFunctionResult = [boolean, Cell['v'], string];

type ExecFunctionOptions = {
    id?: string;
    calcChainSet?: Set<string>;
    notInsertFunc?: boolean;
    // A pass over many formulas shares one, so no formula takes its own snapshot of the workbook.
    resolver?: CellResolver;
};

export function execfunction(
    ctx: Context,
    txt: string,
    r: number,
    c: number,
    {
        id = ctx.currentSheetId,
        calcChainSet,
        notInsertFunc,
        resolver = createArrayResolver(snapshotContext(ctx).sheets),
    }: ExecFunctionOptions = {},
): ExecFunctionResult {
    if (txt.indexOf(error.r) > -1) {
        return [false, error.r, txt];
    }

    if (!checkBracketNum(txt)) {
        txt += ')';
    }

    const result = ctx.formulaCache.engine.evaluate(txt, id, resolver).value;

    if (!notInsertFunc) {
        insertUpdateFunctionGroup(ctx, r, c, id, calcChainSet);
    }

    return [true, result, txt];
}

export function setFormulaCellInfoMap(ctx: Context, calcChains?: FormulaCell[], data?: CellMatrix | null): void {
    if (calcChains == null) return;
    for (let i = 0; i < calcChains.length; i += 1) {
        const formulaCell = calcChains[i];
        setFormulaCellInfo(ctx, formulaCell, data ?? undefined);
    }
}

// `data` stands in for the current sheet's matrix, as in setFormulaCellInfo.
export function warmFormulaCellInfoMap(ctx: Context, data?: CellMatrix | null): FormulaCellInfoMap {
    if (ctx.formulaCache.formulaCellInfoMap != null) return ctx.formulaCache.formulaCellInfoMap;
    // Inside an edit ctx and data are immer drafts, and reading every formula through them is slow.
    const snap = snapshotContext(ctx);
    const map: FormulaCellInfoMap = {};
    ctx.formulaCache.formulaCellInfoMap = map;
    const matrix = data && isDraft(data) ? current(data) : data;
    setFormulaCellInfoMap(snap, getAllFunctionGroup(snap), matrix ?? getFlowdata(snap));
    return map;
}

// Builds the formula map while the browser is idle, such as after a load or a replay of the op log, so neither waits
// for it and the next formula edit finds it ready. Returns the cancel.
export function warmFormulaCellInfoMapOnIdle(getContext: () => Context): () => void {
    const run = () => warmFormulaCellInfoMap(getContext());
    if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 2000 });
        return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 200);
    return () => clearTimeout(id);
}

// Recomputes every formula that reads a cell in `changedCells`, directly or through another formula, and writes the
// values that changed. The cells are already written, and the formula map already knows them.
export function execFunctionGroup(ctx: Context, changedCells: readonly FormulaCell[]): void {
    const formulaCellInfoMap = warmFormulaCellInfoMap(ctx);
    const { dependencyIndex } = ctx.formulaCache;

    // Each affected formula's `dependents` is refilled so the sort below sees fresh edges.
    const affected: FormulaCellInfo[] = [];
    const affectedKeys = new Set<string>();
    const collect = (key: string) => {
        const info = formulaCellInfoMap[key];
        if (info == null || affectedKeys.has(key)) return;
        affectedKeys.add(key);
        affected.push(info);
    };

    for (const cell of changedCells) {
        for (const key of dependencyIndex.dependentsOf(cell.id, cell.r, cell.c)) collect(key);
    }

    for (let i = 0; i < affected.length; i += 1) {
        const node = affected[i];
        node.dependents = dependencyIndex.dependentsOf(node.id, node.r, node.c);
        for (const key of node.dependents) collect(key);
    }

    const runList = getCalculationOrder(affected, formulaCellInfoMap);
    if (runList.length === 0) return;

    // Reading cells through immer drafts is slow, so the pass reads a plain view it can't write. Each value it computes
    // reaches the next formula through `computed`.
    const snapshot = snapshotContext(ctx);
    const computed = new Map<string, Cell>();
    const resolver = withComputedValues(createArrayResolver(snapshot.sheets), computed);
    const calcChainSet = new Set(getAllFunctionGroup(snapshot).map((item) => `${item.r}_${item.c}_${item.id}`));
    const results = runList.map(({ formula, r, c, id }) => {
        const [, v, f] = execfunction(ctx, formula, r, c, { id, calcChainSet, resolver });
        const value: Cell = { v, f };
        computed.set(`${r}_${c}_${id}`, value);
        return { r, c, id, value };
    });

    // Most recomputed formulas land on their previous value, and a draft write is what immer's finalize pays for.
    for (const { r, c, id, value } of results) {
        const idx = getSheetIndex(snapshot, id);
        // A deleted sheet's formula-map entries linger until the next rebuild; this skip makes them harmless.
        if (idx == null) continue;
        const before = snapshot.sheets[idx].data?.[r]?.[c];
        if (before != null && before.v === value.v && before.f === value.f) continue;
        const { data } = ctx.sheets[idx];
        if (data != null) setCellValue(ctx, r, c, data, value);
    }
}
