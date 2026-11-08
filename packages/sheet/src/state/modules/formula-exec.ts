// Formula execution in the editor: evaluating a cell's formula, keeping the calc chain of formula cells, and
// recomputing the cells an edit affects (execFunctionGroup). These read and write the workbook context, so they live
// in the state layer, while the parsing and evaluating they call into is the engine's.

import { current, isDraft } from 'immer';
import { findSheetByName } from '../../engine/a1-notation';
import { getCalculationOrder } from '../../engine/dependency-graph';
import { checkBracketNum, resolveCellRange } from '../../engine/formula-utils';
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
import { createContextResolver, executeAffectedFormulas, setFormulaCellInfo, snapshotContext } from './formula-cache';
import { error } from './validation';

export function getcellrange(
    ctx: Context,
    txt: string,
    formulaId?: string,
    data?: CellMatrix,
): FormulaDependency | null {
    return resolveCellRange(
        {
            sheets: ctx.sheets,
            findSheet: (name) => findSheetByName(ctx.sheets, name),
            cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
        },
        txt,
        formulaId ?? ctx.currentSheetId,
        data || getFlowdata(ctx, formulaId),
    );
}

export function getAllFunctionGroup(ctx: Context): FormulaCell[] {
    const { sheets } = ctx;
    const ret: FormulaCell[] = [];
    for (let i = 0; i < sheets.length; i += 1) {
        const file = sheets[i];
        const { calcChain, dynamicArray_compute } = file;

        if (calcChain != null) {
            for (const c of calcChain) {
                ret.push(c);
            }
        }
        if (dynamicArray_compute != null) {
            for (const d of dynamicArray_compute) {
                ret.push({ r: d.r, c: d.c, id: d.id });
            }
        }
    }

    return ret;
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

    const { dynamicArray } = file;
    if (dynamicArray != null) {
        let modified = false;
        const dynamicArrayClone = dynamicArray.slice();
        for (let i = 0; i < dynamicArrayClone.length; i += 1) {
            const calc = dynamicArrayClone[i];
            if (calc.r === r && calc.c === c && (calc.id == null || calc.id === id)) {
                dynamicArrayClone.splice(i, 1);
                modified = true;
                break;
            }
        }
        if (modified) {
            file.dynamicArray = dynamicArrayClone;
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

export function execfunction(
    ctx: Context,
    txt: string,
    r: number,
    c: number,
    id?: string,
    calcChainSet?: Set<string>,
    isrefresh?: boolean,
    notInsertFunc?: boolean,
    resolver?: CellResolver,
): ExecFunctionResult {
    if (txt.indexOf(error.r) > -1) {
        return [false, error.r, txt];
    }

    if (!checkBracketNum(txt)) {
        txt += ')';
    }

    if (id == null) {
        id = ctx.currentSheetId;
    }

    resolver ??= createContextResolver(snapshotContext(ctx));
    const evalResult = ctx.formulaCache.engine.evaluate(txt, id, resolver);
    const result = evalResult.value;

    if (r != null && c != null) {
        if (isrefresh) {
            execFunctionGroup(ctx, r, c, result, id);
        }

        if (!notInsertFunc) {
            insertUpdateFunctionGroup(ctx, r, c, id, calcChainSet);
        }
    }

    return [true, result, txt];
}

export function groupValuesRefresh(ctx: Context): void {
    if (ctx.groupValuesRefreshData.length === 0) return;

    // Most recomputed formulas land on their previous value. Compare against a
    // plain snapshot and only write real changes — draft writes are what the
    // immer finalize/patch pass pays for.
    const snapshot = snapshotContext(ctx);

    for (const item of ctx.groupValuesRefreshData) {
        const idx = getSheetIndex(snapshot, item.id);
        // A deleted sheet's formula-map entries linger until the next rebuild; this skip makes them harmless.
        if (idx == null) continue;

        const before = snapshot.sheets[idx].data?.[item.r]?.[item.c];
        if (before != null && before.v === item.v && before.f === item.f) continue;

        const { data } = ctx.sheets[idx];
        if (data == null) continue;

        setCellValue(ctx, item.r, item.c, data, { v: item.v, f: item.f });
    }

    ctx.groupValuesRefreshData = [];
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

export function execFunctionGroup(
    ctx: Context,
    origin_r: number | null,
    origin_c: number | null,
    value: unknown,
    id?: string | null,
    data?: CellMatrix | null,
): void {
    if (ctx.formulaCache.execFunctionGlobalData == null) {
        ctx.formulaCache.execFunctionGlobalData = {};
    }
    if (id == null) {
        id = ctx.currentSheetId;
    }

    if (value != null) {
        const cellCache: Cell[][] = [[{ v: undefined }]];
        setCellValue(ctx, 0, 0, cellCache, value);
        [[ctx.formulaCache.execFunctionGlobalData[`${origin_r}_${origin_c}_${id}`]]] = cellCache;
    }

    // Reading cells through immer drafts is slow, so the recalc reads a plain view. It is taken lazily, because an
    // edit with no dependents needs none.
    let snap: Context | null = null;
    const getSnapshot = () => (snap ??= snapshotContext(ctx));
    let allChains: FormulaCell[] | null = null;
    const getChains = () => (allChains ??= getAllFunctionGroup(getSnapshot()));

    const changedCells: FormulaCell[] =
        ctx.formulaCache.execFunctionExist ??
        (origin_r != null && origin_c != null ? [{ r: origin_r, c: origin_c, id }] : []);

    const formulaCellInfoMap = warmFormulaCellInfoMap(ctx, id === ctx.currentSheetId ? data : undefined);
    const { dependencyIndex } = ctx.formulaCache;

    // Each affected formula's `parents`, which are its dependents, is refilled so the sort below sees fresh edges.
    const affected: FormulaCellInfo[] = [];
    const affectedKeys = new Set<string>();
    const collect = (key: string) => {
        const info = formulaCellInfoMap[key];
        if (info == null || affectedKeys.has(key)) return;
        affectedKeys.add(key);
        affected.push(info);
    };

    for (const cell of changedCells) {
        for (const key of dependencyIndex.dependentsOf(cell.id ?? id, cell.r, cell.c)) {
            collect(key);
        }
    }

    for (let i = 0; i < affected.length; i += 1) {
        const node = affected[i];
        node.parents = {};
        for (const key of dependencyIndex.dependentsOf(node.id, node.r, node.c)) {
            node.parents[key] = 1;
            collect(key);
        }
    }

    const formulaRunList = getCalculationOrder(affected, formulaCellInfoMap);

    if (formulaRunList.length > 0) {
        executeAffectedFormulas(ctx, formulaRunList, getChains(), createContextResolver(getSnapshot()));
    }

    ctx.formulaCache.execFunctionExist = undefined;
}
