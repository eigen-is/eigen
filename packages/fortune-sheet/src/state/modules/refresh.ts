import {Context, getFlowdata} from "../context";
import {CellMatrix, Selection} from "../types";
import {execFunctionGroup} from "./formula-ui";
import {setFormulaCellInfo} from "./formulaHelper";

function runExecFunction(
    ctx: Context,
    range: Selection[],
    index: string,
    data: any
) {
    ctx.formulaCache.execFunctionExist = [];
    for (let s = 0; s < range.length; s += 1) {
        for (let r = range[s].row[0]; r <= range[s].row[1]; r += 1) {
            for (let c = range[s].column[0]; c <= range[s].column[1]; c += 1) {
                setFormulaCellInfo(ctx, {r, c, id: index}, data);
                ctx.formulaCache.execFunctionExist.push({r, c, i: index});
            }
        }
    }
    ctx.formulaCache.execFunctionExist.reverse();
    // @ts-ignore
    execFunctionGroup(ctx, null, null, null, null, data);
    ctx.formulaCache.execFunctionGlobalData = null;
}

export function jfrefreshgrid(
    ctx: Context,
    data: CellMatrix | null,
    range: Selection[] | undefined,
    isRunExecFunction = true
) {
    if (data == null) {
        data = getFlowdata(ctx)!;
    }

    if (range == null) {
        range = ctx.luckysheet_select_save;
        if (range == null) return;
    }

    // clearTimeout(refreshCanvasTimeOut);

    // Update data range
    // for (let s = 0; s < range.length; s += 1) {
    //   const r1 = range[s].row[0];
    //   const c1 = range[s].column[0];

    //   if (server.allowUpdate) {
    //     // Collaborative editing mode
    //     server.historyParam(ctx.flowdata, ctx.currentSheetIndex, range[s]);
    //   }
    //   // Refresh charts
    //   if (typeof ctx.chartparam.jfrefreshchartall === "function") {
    //     ctx.chartparam.jfrefreshchartall(
    //       ctx.flowdata,
    //       range[s].row[0],
    //       range[s].row[1],
    //       range[s].column[0],
    //       range[s].column[1]
    //     );
    //   }
    // }

    // Trigger linked updates when cell data changes
    if (isRunExecFunction) {
        runExecFunction(ctx, range, ctx.currentSheetId, data);
    }

    /* Sync selection */
    // selectHightlightShow();
}
