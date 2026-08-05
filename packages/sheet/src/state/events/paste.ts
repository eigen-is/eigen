import type {
    BorderInfo,
    CellBorderInfo,
    ConditionalFormatRule,
    DataVerificationRule,
    RangeBorderInfo,
} from '@workspace/lib/sheets';
import {
    cloneDeep,
    forEach,
    fromPairs,
    has,
    includes,
    initial,
    isEmpty,
    isNil,
    isPlainObject,
    trim,
    zip,
} from 'es-toolkit/compat';
import { cfSplitRange } from '../../engine/conditional-format';
import { genarate, update } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { Cell, CellMatrix, InlineStringSegment, SingleRange } from '../../engine/types';
import { setRowHeight } from '../api';
import { type Context, getFlowdata } from '../context';
import { en } from '../locale/en';
import { getBorderInfoCompute } from '../modules/border';
import { getdatabyselection, getQKBorder } from '../modules/cell';
import { createContextResolver, setFormulaCellInfo } from '../modules/formula-cache';
import { delFunctionGroup, execFunctionGroup, execfunction } from '../modules/formula-exec';
import { jfrefreshgrid } from '../modules/refresh';
import { normalizeSelection, selectionCache } from '../modules/selection';
import { expandRowsAndColumns, storeSheetParamALL } from '../modules/sheet';
import { hasPartMC, isRealNum } from '../modules/validation';
import type { SheetConfig } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';

// Snapshot built by pasteHandlerOfCutPaste describing the source and target
// sides of a cut/paste so postPasteCut can splice both sheets at once.
type CutPasteSide = {
    sheetId: string;
    data: CellMatrix | undefined;
    curData: CellMatrix;
    config: SheetConfig | undefined;
    curConfig: SheetConfig;
    cdformat: ConditionalFormatRule[] | undefined;
    curCdformat: ConditionalFormatRule[] | undefined;
    dataVerification: Record<string, DataVerificationRule> | undefined;
    curDataVerification: Record<string, DataVerificationRule>;
    range: { row: number[]; column: number[] };
};

function postPasteCut(ctx: Context, source: CutPasteSide, target: CutPasteSide, RowlChange: boolean) {
    // trigger linked cell data updates
    const execF_rc: Record<string, number> = {};
    ctx.formulaCache.execFunctionExist = [];
    for (let r = source.range.row[0]; r <= source.range.row[1]; r += 1) {
        for (let c = source.range.column[0]; c <= source.range.column[1]; c += 1) {
            setFormulaCellInfo(ctx, { r, c, id: source.sheetId });
            if (`${r}_${c}_${source.sheetId}` in execF_rc) {
                continue;
            }

            execF_rc[`${r}_${c}_${source.sheetId}`] = 0;
            ctx.formulaCache.execFunctionExist.push({ r, c, id: source.sheetId });
        }
    }

    for (let r = target.range.row[0]; r <= target.range.row[1]; r += 1) {
        for (let c = target.range.column[0]; c <= target.range.column[1]; c += 1) {
            setFormulaCellInfo(ctx, { r, c, id: source.sheetId });
            if (`${r}_${c}_${target.sheetId}` in execF_rc) {
                continue;
            }

            execF_rc[`${r}_${c}_${target.sheetId}`] = 0;
            ctx.formulaCache.execFunctionExist.push({ r, c, id: target.sheetId });
        }
    }

    // config
    let rowHeight = 0;
    if (ctx.currentSheetId === source.sheetId) {
        ctx.config = source.curConfig;
        rowHeight = source.curData.length;
        ctx.sheets[getSheetIndex(ctx, target.sheetId)!].config = target.curConfig;
    } else if (ctx.currentSheetId === target.sheetId) {
        ctx.config = target.curConfig;
        rowHeight = target.curData.length;
        ctx.sheets[getSheetIndex(ctx, source.sheetId)!].config = source.curConfig;
    }

    if (RowlChange) {
        ctx.visibledatarow = [];
        ctx.rh_height = 0;

        for (let i = 0; i < rowHeight; i += 1) {
            let rowlen = ctx.defaultrowlen;

            if (ctx.config.rowlen != null && ctx.config.rowlen[i] != null) {
                rowlen = ctx.config.rowlen[i];
            }

            if (ctx.config.rowhidden != null && ctx.config.rowhidden[i] != null) {
                rowlen = ctx.config.rowhidden[i];
                ctx.visibledatarow.push(ctx.rh_height);
                continue;
            } else {
                ctx.rh_height += rowlen + 1;
            }

            ctx.visibledatarow.push(ctx.rh_height); // temporary row height distribution
        }
        ctx.rh_height += 80;
    }

    if (ctx.currentSheetId === source.sheetId) {
        ctx.sheets[getSheetIndex(ctx, target.sheetId)!].data = target.curData;
    } else if (ctx.currentSheetId === target.sheetId) {
        ctx.sheets[getSheetIndex(ctx, source.sheetId)!].data = source.curData;
    }

    // selections
    if (ctx.currentSheetId === target.sheetId) {
        ctx.selections = [{ row: target.range.row, column: target.range.column }];
    } else {
        ctx.selections = [{ row: source.range.row, column: source.range.column }];
    }
    // conditional formatting
    ctx.sheets[getSheetIndex(ctx, source.sheetId)!].conditionalFormatRules = source.curCdformat;
    ctx.sheets[getSheetIndex(ctx, target.sheetId)!].conditionalFormatRules = target.curCdformat;

    ctx.sheets[getSheetIndex(ctx, source.sheetId)!].dataVerification = source.curDataVerification;
    ctx.sheets[getSheetIndex(ctx, target.sheetId)!].dataVerification = target.curDataVerification;

    ctx.formulaCache.execFunctionExist.reverse();
    execFunctionGroup(ctx, null, null, null, null, target.curData);
    ctx.formulaCache.execFunctionGlobalData = null;

    storeSheetParamALL(ctx);
}

// Per-cell border map produced by the HTML paste path before being attached to
// cfg.borderInfo. Keyed by `${row}_${col}` relative to the pasted block; sides
// are the `BorderSide` shape getQKBorder returns.
type CellBorderMap = Record<string, Pick<CellBorderInfo['value'], 'l' | 'r' | 't' | 'b'>>;

function pasteHandler(ctx: Context, data: CellMatrix | string, borderInfo?: CellBorderMap) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if ((ctx.selections?.length ?? 0) !== 1) {
        return;
    }

    if (typeof data === 'object') {
        if (data.length === 0) {
            return;
        }

        const cfg = ctx.config || {};
        if (cfg.merge == null) {
            cfg.merge = {};
        }

        if (JSON.stringify(borderInfo).length > 2 && cfg.borderInfo == null) {
            cfg.borderInfo = [];
        }

        const copyh = data.length;
        const copyc = data[0].length;

        const minh = ctx.selections![0].row[0]; // first and last row of apply range
        const maxh = minh + copyh - 1;
        const minc = ctx.selections![0].column[0]; // first and last column of apply range
        const maxc = minc + copyc - 1;

        // return with a warning if the apply range contains partially merged cells
        let has_PartMC = false;
        if (cfg.merge != null) {
            has_PartMC = hasPartMC(ctx, minh, maxh, minc, maxc);
        }

        if (has_PartMC) {
            return;
        }

        const d = getFlowdata(ctx); // fetch data
        if (!d) return;

        const rowMaxLength = d.length;
        const cellMaxLength = d[0].length;

        // expand rows/columns if the apply range exceeds the current maximum
        const addr = maxh - rowMaxLength + 1;
        const addc = maxc - cellMaxLength + 1;
        if (addr > 0 || addc > 0) {
            expandRowsAndColumns(d, addr, addc);
        }
        if (!d) return;

        if (cfg.rowlen == null) {
            cfg.rowlen = {};
        }

        const offsetMC: Record<string, [number, number]> = {};
        for (let h = minh; h <= maxh; h += 1) {
            const x = d[h];

            let currentRowLen = ctx.defaultrowlen;
            if (cfg.rowlen[h] != null) {
                currentRowLen = cfg.rowlen[h];
            }

            for (let c = minc; c <= maxc; c += 1) {
                if (x?.[c]?.mc) {
                    if ('rs' in x[c]!.mc!) {
                        delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
                    }
                    delete x![c]!.mc;
                }

                let value: Cell | null = null;
                if (data[h - minh] != null && data[h - minh][c - minc] != null) {
                    value = data[h - minh][c - minc];
                }

                x[c] = value;

                const cellMc = x[c]?.mc;
                if (value != null && cellMc) {
                    const valueMc = value.mc;
                    if (cellMc.rs != null && valueMc != null) {
                        cellMc.r = h;
                        cellMc.c = c;

                        cfg.merge[`${cellMc.r}_${cellMc.c}`] = {
                            r: cellMc.r,
                            c: cellMc.c,
                            rs: cellMc.rs,
                            cs: cellMc.cs ?? 1,
                        };

                        offsetMC[`${valueMc.r}_${valueMc.c}`] = [cellMc.r, cellMc.c];
                    } else if (valueMc != null) {
                        x[c] = {
                            mc: {
                                r: offsetMC[`${valueMc.r}_${valueMc.c}`][0],
                                c: offsetMC[`${valueMc.r}_${valueMc.c}`][1],
                            },
                        };
                    }
                }

                const borderEntry = borderInfo?.[`${h - minh}_${c - minc}`];
                if (borderEntry) {
                    const bd_obj: CellBorderInfo = {
                        rangeType: 'cell',
                        value: {
                            row_index: h,
                            col_index: c,
                            l: borderEntry.l,
                            r: borderEntry.r,
                            t: borderEntry.t,
                            b: borderEntry.b,
                        },
                    };

                    cfg.borderInfo?.push(bd_obj);
                }
            }
            d[h] = x;

            if (currentRowLen !== ctx.defaultrowlen) {
                cfg.rowlen[h] = currentRowLen;
            }
        }

        ctx.selections = [{ row: [minh, maxh], column: [minc, maxc] }];

        ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].config = cfg;
        jfrefreshgrid(ctx, null, undefined);
    } else {
        data = data.replace(/\r/g, '');
        const dataChe = [];
        const che = data.split('\n');
        const colchelen = che[0].split('\t').length;

        for (let i = 0; i < che.length; i += 1) {
            if (che[i].split('\t').length < colchelen) {
                continue;
            }

            dataChe.push(che[i].split('\t'));
        }

        const d = getFlowdata(ctx); // fetch data
        if (!d) return;

        const last = ctx.selections?.[ctx.selections.length - 1];
        if (!last) return;

        const curR = last.row == null ? 0 : last.row[0];
        const curC = last.column == null ? 0 : last.column[0];
        const rlen = dataChe.length;
        const clen = dataChe[0].length;

        // return with a warning if the apply range contains partially merged cells
        let has_PartMC = false;
        if (ctx.config.merge != null) {
            has_PartMC = hasPartMC(ctx, curR, curR + rlen - 1, curC, curC + clen - 1);
        }

        if (has_PartMC) {
            return;
        }

        const addr = curR + rlen - d.length;
        const addc = curC + clen - d[0].length;
        if (addr > 0 || addc > 0) {
            expandRowsAndColumns(d, addr, addc);
        }
        if (!d) return;

        for (let r = 0; r < rlen; r += 1) {
            const x = d[r + curR];
            for (let c = 0; c < clen; c += 1) {
                const originCell = x[c + curC];
                let value: string | number = dataChe[r][c];
                if (isRealNum(value)) {
                    // if the cell is formatted as plain text, do not convert to a numeric type
                    // to prevent large numbers from being automatically displayed in scientific notation
                    if (originCell?.ct && originCell.ct.fa === '@') {
                        value = String(value);
                    } else {
                        value = parseFloat(value as string);
                    }
                }
                if (originCell) {
                    originCell.v = value;
                    if (originCell.ct != null && originCell.ct.fa != null) {
                        originCell.m = update(originCell.ct.fa, value);
                    } else {
                        originCell.m = value;
                    }

                    if (originCell.f != null && originCell.f.length > 0) {
                        originCell.f = '';
                        delFunctionGroup(ctx, r + curR, c + curC, ctx.currentSheetId);
                    }
                } else {
                    const cell: Cell = {};
                    const mask = genarate(value);
                    [cell.m, cell.ct, cell.v] = mask!;

                    x[c + curC] = cell;
                }
            }
            d[r + curR] = x;
        }

        last.row = [curR, curR + rlen - 1];
        last.column = [curC, curC + clen - 1];

        jfrefreshgrid(ctx, null, undefined);
    }
}

function setCellHyperlink(
    ctx: Context,
    id: string,
    r: number,
    c: number,
    link: { linkType: string; linkAddress: string },
) {
    const index = getSheetIndex(ctx, id) as number;
    if (!ctx.sheets[index].hyperlink) {
        ctx.sheets[index].hyperlink = {};
    }
    ctx.sheets[index]!.hyperlink![`${r}_${c}`] = link;
}

function pasteHandlerOfCutPaste(ctx: Context, copyRange: Context['copyState']) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (!copyRange) return;

    const cfg = ctx.config || {};
    if (cfg.merge == null) {
        cfg.merge = {};
    }

    // copy range
    const copyHasMC = copyRange.HasMC;
    const copyRowlChange = copyRange.RowlChange;
    const copySheetId = copyRange.dataSheetId;

    const c_r1 = copyRange.copyRange[0].row[0];
    const c_r2 = copyRange.copyRange[0].row[1];
    const c_c1 = copyRange.copyRange[0].column[0];
    const c_c2 = copyRange.copyRange[0].column[1];

    const copyData = cloneDeep(getdatabyselection(ctx, { row: [c_r1, c_r2], column: [c_c1, c_c2] }, copySheetId));

    const copyh = copyData.length;
    const copyc = copyData[0].length;

    // apply range
    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last || last.row_focus == null || last.column_focus == null) return;

    const minh = last.row_focus;
    const maxh = minh + copyh - 1; // first and last row of apply range
    const minc = last.column_focus;
    const maxc = minc + copyc - 1; // first and last column of apply range

    // warn if the apply range contains partially merged cells
    let has_PartMC = false;
    if (cfg.merge != null) {
        has_PartMC = hasPartMC(ctx, minh, maxh, minc, maxc);
    }

    if (has_PartMC) {
        return;
    }

    const d = getFlowdata(ctx); // fetch data
    if (!d) return;
    const rowMaxLength = d.length;
    const cellMaxLength = d[0].length;

    const addr = copyh + minh - rowMaxLength;
    const addc = copyc + minc - cellMaxLength;
    if (addr > 0 || addc > 0) {
        expandRowsAndColumns(d, addr, addc);
    }

    const borderInfoCompute = getBorderInfoCompute(ctx, copySheetId);
    const c_dataVerification = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetId)!].dataVerification) || {};
    const dataVerification = cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].dataVerification) || {};

    // if the selection contains hyperlinks
    if (ctx.selections?.length === 1 && ctx.copyState?.copyRange.length === 1) {
        forEach(ctx.copyState?.copyRange, (range) => {
            for (let r = 0; r <= range.row[1] - range.row[0]; r += 1) {
                for (let c = 0; c <= range.column[1] - range.column[0]; c += 1) {
                    const index = getSheetIndex(ctx, ctx.copyState?.dataSheetId as string) as number;
                    if (
                        ctx.sheets[index]!.data![r + range.row[0]][c + range.column[0]]?.hl &&
                        ctx.sheets[index].hyperlink![`${r}_${c}`]
                    ) {
                        setCellHyperlink(
                            ctx,
                            ctx.copyState?.dataSheetId as string,
                            r + ctx.selections![0].row[0],
                            c + ctx.selections![0].column[0],
                            ctx.sheets[index].hyperlink![`${r}_${c}`],
                        );
                    }
                }
            }
        });
    }

    // cut-paste within the current sheet: delete data, merged cells, data validation, and hyperlinks in the cut range
    if (ctx.currentSheetId === copySheetId) {
        for (let i = c_r1; i <= c_r2; i += 1) {
            for (let j = c_c1; j <= c_c2; j += 1) {
                const cell = d[i][j];

                if (cell && isPlainObject(cell) && 'mc' in cell) {
                    if (cell.mc?.rs != null) {
                        delete cfg.merge[`${cell.mc.r}_${cell.mc.c}`];
                    }
                    delete cell.mc;
                }

                d[i][j] = null;

                delete dataVerification[`${i}_${j}`];

                delete ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number].hyperlink?.[`${i}_${j}`];
            }
        }

        // borders
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const source_borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const bd_emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        bd_emptyRange.push(
                            ...cfSplitRange(
                                entry.range[j],
                                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                                { row: [minh, maxh], column: [minc, maxc] },
                                'restPart',
                            ),
                        );
                    }

                    entry.range = bd_emptyRange;
                    source_borderInfo.push(entry);
                } else {
                    const bd_r = entry.value.row_index;
                    const bd_c = entry.value.col_index;

                    if (!(bd_r >= c_r1 && bd_r <= c_r2 && bd_c >= c_c1 && bd_c <= c_c2)) {
                        source_borderInfo.push(entry);
                    }
                }
            }

            cfg.borderInfo = source_borderInfo;
        }
    }

    const offsetMC: Record<string, [number, number]> = {};
    for (let h = minh; h <= maxh; h += 1) {
        const x = d[h];

        for (let c = minc; c <= maxc; c += 1) {
            const computeEntry = borderInfoCompute[`${c_r1 + h - minh}_${c_c1 + c - minc}`];
            if (computeEntry && !computeEntry.s) {
                const bd_obj: CellBorderInfo = {
                    rangeType: 'cell',
                    value: {
                        row_index: h,
                        col_index: c,
                        l: computeEntry.l,
                        r: computeEntry.r,
                        t: computeEntry.t,
                        b: computeEntry.b,
                    },
                };

                if (cfg.borderInfo == null) {
                    cfg.borderInfo = [];
                }

                cfg.borderInfo.push(bd_obj);
            } else if (borderInfoCompute[`${h}_${c}`]) {
                const bd_obj: CellBorderInfo = {
                    rangeType: 'cell',
                    value: {
                        row_index: h,
                        col_index: c,
                        l: null,
                        r: null,
                        t: null,
                        b: null,
                    },
                };

                if (cfg.borderInfo == null) {
                    cfg.borderInfo = [];
                }

                cfg.borderInfo.push(bd_obj);
            } else if (computeEntry) {
                const bd_obj: RangeBorderInfo = {
                    rangeType: 'range',
                    borderType: 'border-slash',
                    color: computeEntry.s!.color,
                    style: computeEntry.s!.style,
                    range: normalizeSelection(ctx, [{ row: [h, h], column: [c, c] }]),
                };

                if (cfg.borderInfo == null) {
                    cfg.borderInfo = [];
                }

                cfg.borderInfo.push(bd_obj);
            }

            // data validation: cut
            if (c_dataVerification[`${c_r1 + h - minh}_${c_c1 + c - minc}`]) {
                dataVerification[`${h}_${c}`] = c_dataVerification[`${c_r1 + h - minh}_${c_c1 + c - minc}`];
            }

            if (x[c]?.mc) {
                if (x[c]?.mc?.rs != null) {
                    delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
                }
                delete x[c]!.mc;
            }

            let value: Cell | null = null;
            if (copyData[h - minh] != null && copyData[h - minh][c - minc] != null) {
                value = copyData[h - minh][c - minc];
            }

            x[c] = cloneDeep(value);

            const cellMc = x[c]?.mc;
            if (value != null && copyHasMC && cellMc) {
                const valueMc = value.mc;
                if (cellMc.rs != null && valueMc != null) {
                    cellMc.r = h;
                    cellMc.c = c;

                    cfg.merge[`${cellMc.r}_${cellMc.c}`] = {
                        r: cellMc.r,
                        c: cellMc.c,
                        rs: cellMc.rs,
                        cs: cellMc.cs ?? 1,
                    };

                    offsetMC[`${valueMc.r}_${valueMc.c}`] = [cellMc.r, cellMc.c];
                } else if (valueMc != null) {
                    x[c] = {
                        mc: {
                            r: offsetMC[`${valueMc.r}_${valueMc.c}`][0],
                            c: offsetMC[`${valueMc.r}_${valueMc.c}`][1],
                        },
                    };
                }
            }
        }

        d[h] = x;
    }

    last.row = [minh, maxh];
    last.column = [minc, maxc];

    let source: CutPasteSide;
    let target: CutPasteSide;
    if (ctx.currentSheetId !== copySheetId) {
        // cross-sheet operation
        const sourceData = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetId)!].data!);
        const sourceConfig = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetId)!].config);

        const sourceCurData = cloneDeep(sourceData);
        const sourceCurConfig = cloneDeep(sourceConfig) || {};
        if (sourceCurConfig.merge == null) {
            sourceCurConfig.merge = {};
        }

        for (let source_r = c_r1; source_r <= c_r2; source_r += 1) {
            for (let source_c = c_c1; source_c <= c_c2; source_c += 1) {
                const cell = sourceCurData[source_r][source_c];

                if (cell?.mc) {
                    if ('rs' in cell.mc) {
                        delete sourceCurConfig.merge[`${cell.mc.r}_${cell.mc.c}`];
                    }
                    delete cell.mc;
                }
                sourceCurData[source_r][source_c] = null;
            }
        }

        // borders
        if (sourceCurConfig.borderInfo && sourceCurConfig.borderInfo.length > 0) {
            const source_borderInfo: BorderInfo[] = [];

            for (let i = 0; i < sourceCurConfig.borderInfo.length; i += 1) {
                const entry = sourceCurConfig.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const bd_emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        bd_emptyRange.push(
                            ...cfSplitRange(
                                entry.range[j],
                                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                                { row: [minh, maxh], column: [minc, maxc] },
                                'restPart',
                            ),
                        );
                    }

                    entry.range = bd_emptyRange;
                    source_borderInfo.push(entry);
                } else {
                    const bd_r = entry.value.row_index;
                    const bd_c = entry.value.col_index;

                    if (!(bd_r >= c_r1 && bd_r <= c_r2 && bd_c >= c_c1 && bd_c <= c_c2)) {
                        source_borderInfo.push(entry);
                    }
                }
            }

            sourceCurConfig.borderInfo = source_borderInfo;
        }

        // conditional formatting
        const source_cdformat = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetId)!].conditionalFormatRules);
        const source_curCdformat = cloneDeep(source_cdformat);
        const ruleArr: ConditionalFormatRule[] = [];

        if (source_curCdformat != null && source_curCdformat.length > 0) {
            for (let i = 0; i < source_curCdformat.length; i += 1) {
                const source_curCdformat_cellrange = source_curCdformat[i].cellrange;
                const emptyRange: SingleRange[] = [];
                const emptyRange2: SingleRange[] = [];

                for (let j = 0; j < source_curCdformat_cellrange.length; j += 1) {
                    const range = cfSplitRange(
                        source_curCdformat_cellrange[j],
                        { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                        { row: [minh, maxh], column: [minc, maxc] },
                        'restPart',
                    );

                    emptyRange.push(...range);

                    const range2 = cfSplitRange(
                        source_curCdformat_cellrange[j],
                        { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                        { row: [minh, maxh], column: [minc, maxc] },
                        'operatePart',
                    );

                    emptyRange2.push(...range2);
                }

                source_curCdformat[i].cellrange = emptyRange;

                if (emptyRange2.length > 0) {
                    // Clone so the target keeps the operate-part range without aliasing
                    // back into source_curCdformat[i] (which now owns emptyRange).
                    ruleArr.push({ ...cloneDeep(source_curCdformat[i]), cellrange: emptyRange2 });
                }
            }
        }

        const target_cdformat = cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].conditionalFormatRules);
        let target_curCdformat = cloneDeep(target_cdformat);
        if (ruleArr.length > 0) {
            target_curCdformat = target_curCdformat?.concat(ruleArr);
        }

        // data validation
        for (let i = c_r1; i <= c_r2; i += 1) {
            for (let j = c_c1; j <= c_c2; j += 1) {
                delete c_dataVerification[`${i}_${j}`];
            }
        }

        source = {
            sheetId: copySheetId,
            data: sourceData,
            curData: sourceCurData,
            config: sourceConfig,
            curConfig: sourceCurConfig,
            cdformat: source_cdformat,
            curCdformat: source_curCdformat,
            dataVerification: cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetId)!].dataVerification),
            curDataVerification: c_dataVerification,
            range: {
                row: [c_r1, c_r2],
                column: [c_c1, c_c2],
            },
        };
        target = {
            sheetId: ctx.currentSheetId,
            data: getFlowdata(ctx) ?? undefined,
            curData: d,
            config: cloneDeep(ctx.config),
            curConfig: cfg,
            cdformat: target_cdformat,
            curCdformat: target_curCdformat,
            dataVerification: cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].dataVerification),
            curDataVerification: dataVerification,
            range: {
                row: [minh, maxh],
                column: [minc, maxc],
            },
        };
    } else {
        // conditional formatting
        const cdformat = cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].conditionalFormatRules);
        const curCdformat = cloneDeep(cdformat);
        if (curCdformat != null && curCdformat.length > 0) {
            for (let i = 0; i < curCdformat.length; i += 1) {
                const { cellrange } = curCdformat[i];
                const emptyRange: SingleRange[] = [];
                for (let j = 0; j < cellrange.length; j += 1) {
                    emptyRange.push(
                        ...cfSplitRange(
                            cellrange[j],
                            { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                            { row: [minh, maxh], column: [minc, maxc] },
                            'allPart',
                        ),
                    );
                }
                curCdformat[i].cellrange = emptyRange;
            }
        }

        // same-sheet operation
        source = {
            sheetId: ctx.currentSheetId,
            data: getFlowdata(ctx) ?? undefined,
            curData: d,
            config: cloneDeep(ctx.config),
            curConfig: cfg,
            cdformat,
            curCdformat,
            dataVerification: cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].dataVerification),
            curDataVerification: dataVerification,
            range: {
                row: [c_r1, c_r2],
                column: [c_c1, c_c2],
            },
        };
        target = {
            sheetId: ctx.currentSheetId,
            data: getFlowdata(ctx) ?? undefined,
            curData: d,
            config: cloneDeep(ctx.config),
            curConfig: cfg,
            cdformat,
            curCdformat,
            dataVerification: cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].dataVerification),
            curDataVerification: dataVerification,
            range: {
                row: [minh, maxh],
                column: [minc, maxc],
            },
        };
    }

    if (addr > 0 || addc > 0) {
        postPasteCut(ctx, source, target, true);
    } else {
        postPasteCut(ctx, source, target, copyRowlChange);
    }
}

function pasteHandlerOfCopyPaste(ctx: Context, copyRange: Context['copyState']) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (!copyRange) return;

    // Live resolver, hoisted: one per paste instead of one snapshot per pasted
    // formula, and each evaluation sees the cells pasted before it.
    const resolver = createContextResolver(ctx);

    const cfg = ctx.config;
    if (isNil(cfg.merge)) {
        cfg.merge = {};
    }

    // copy range
    const copyHasMC = copyRange.HasMC;
    const copySheetIndex = copyRange.dataSheetId;

    const c_r1 = copyRange.copyRange[0].row[0];
    const c_r2 = copyRange.copyRange[0].row[1];
    const c_c1 = copyRange.copyRange[0].column[0];
    const c_c2 = copyRange.copyRange[0].column[1];

    let arr: CellMatrix = [];
    let isSameRow = false;
    for (let i = 0; i < copyRange.copyRange.length; i += 1) {
        let arrData = getdatabyselection(
            ctx,
            {
                row: copyRange.copyRange[i].row,
                column: copyRange.copyRange[i].column,
            },
            copySheetIndex,
        );
        if (copyRange.copyRange.length > 1) {
            if (c_r1 === copyRange.copyRange[1].row[0] && c_r2 === copyRange.copyRange[1].row[1]) {
                arrData = arrData[0].map((_col, a) => {
                    return arrData.map((row) => {
                        return row[a];
                    });
                });

                // push per row: concat re-copies the accumulator per range
                for (const row of arrData) arr.push(row);

                isSameRow = true;
            } else if (c_c1 === copyRange.copyRange[1].column[0] && c_c2 === copyRange.copyRange[1].column[1]) {
                for (const row of arrData) arr.push(row);
            }
        } else {
            arr = arrData;
        }
    }

    if (isSameRow) {
        arr = arr[0].map((_col, b) => {
            return arr.map((row) => {
                return row[b];
            });
        });
    }

    const copyData = cloneDeep(arr);

    // for multiple selections, if a cell has a formula, use only the value and discard the formula
    if (copyRange.copyRange.length > 1) {
        for (let i = 0; i < copyData.length; i += 1) {
            for (let j = 0; j < copyData[i].length; j += 1) {
                if (copyData[i][j] != null && copyData[i]![j]!.f != null) {
                    delete copyData[i]![j]!.f;
                }
            }
        }
    }

    const copyh = copyData.length;
    const copyc = copyData[0].length;

    // apply range
    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last) return;
    const minh = last.row[0];
    let maxh = last.row[1]; // first and last row of apply range
    const minc = last.column[0];
    let maxc = last.column[1]; // first and last column of apply range

    const mh = (maxh - minh + 1) % copyh;
    const mc = (maxc - minc + 1) % copyc;

    if (mh !== 0 || mc !== 0) {
        // if the apply range is not an integer multiple of the copy data dimensions, use the copy data dimensions
        maxh = minh + copyh - 1;
        maxc = minc + copyc - 1;
    }

    // warn if the apply range contains partially merged cells
    let has_PartMC = false;
    if (!isNil(cfg.merge)) {
        has_PartMC = hasPartMC(ctx, minh, maxh, minc, maxc);
    }

    if (has_PartMC) {
        return;
    }

    const timesH = (maxh - minh + 1) / copyh;
    const timesC = (maxc - minc + 1) / copyc;

    const d = getFlowdata(ctx); // fetch data
    if (!d) return;

    const rowMaxLength = d.length;
    const cellMaxLength = d[0].length;

    // expand rows/columns if the apply range exceeds the current maximum
    const addr = copyh + minh - rowMaxLength;
    const addc = copyc + minc - cellMaxLength;
    if (addr > 0 || addc > 0) {
        expandRowsAndColumns(d, addr, addc);
    }

    const borderInfoCompute = getBorderInfoCompute(ctx, copySheetIndex);
    const c_dataVerification = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetIndex)!].dataVerification) || {};
    let dataVerification: Record<string, DataVerificationRule> | null = null;

    let mth = 0;
    let mtc = 0;
    let maxcellCahe = 0;
    let maxrowCache = 0;

    const file = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!];
    const hiddenRows = new Set(Object.keys(file.config?.rowhidden || {}));
    const hiddenCols = new Set(Object.keys(file.config?.colhidden || {}));

    for (let th = 1; th <= timesH; th += 1) {
        for (let tc = 1; tc <= timesC; tc += 1) {
            mth = minh + (th - 1) * copyh;
            mtc = minc + (tc - 1) * copyc;
            maxrowCache = minh + th * copyh;
            maxcellCahe = minc + tc * copyc;

            // row/column offset values used when cells contain formulas
            const offsetRow = mth - c_r1;
            const offsetCol = mtc - c_c1;

            const offsetMC: Record<string, [number, number]> = {};
            for (let h = mth; h < maxrowCache; h += 1) {
                // skip if row is hidden
                if (hiddenRows?.has(h.toString())) continue;
                const x = d[h];

                for (let c = mtc; c < maxcellCahe; c += 1) {
                    if (hiddenCols?.has(c.toString())) continue;
                    const computeEntry = borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`];
                    if (computeEntry && !computeEntry.s) {
                        const bd_obj: CellBorderInfo = {
                            rangeType: 'cell',
                            value: {
                                row_index: h,
                                col_index: c,
                                l: computeEntry.l,
                                r: computeEntry.r,
                                t: computeEntry.t,
                                b: computeEntry.b,
                            },
                        };

                        if (isNil(cfg.borderInfo)) {
                            cfg.borderInfo = [];
                        }

                        cfg.borderInfo.push(bd_obj);
                    } else if (computeEntry?.s) {
                        const slashSide = computeEntry.s;
                        const bd_obj: RangeBorderInfo = {
                            rangeType: 'range',
                            borderType: 'border-slash',
                            color: slashSide.color,
                            style: slashSide.style,
                            range: normalizeSelection(ctx, [{ row: [h, h], column: [c, c] }]),
                        };

                        if (cfg.borderInfo == null) {
                            cfg.borderInfo = [];
                        }

                        cfg.borderInfo.push(bd_obj);
                    } else if (borderInfoCompute[`${h}_${c}`]) {
                        // Source has no border at this cell, but source's borderInfo
                        // contains an entry at the destination coords (within-sheet
                        // overlap). Push an explicit null-sides entry so the dest's
                        // pre-existing borders clear at render time.
                        const bd_obj: CellBorderInfo = {
                            rangeType: 'cell',
                            value: {
                                row_index: h,
                                col_index: c,
                                l: null,
                                r: null,
                                t: null,
                                b: null,
                            },
                        };

                        if (isNil(cfg.borderInfo)) {
                            cfg.borderInfo = [];
                        }

                        cfg.borderInfo.push(bd_obj);
                    }

                    // data validation: copy
                    if (c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]) {
                        if (dataVerification == null) {
                            dataVerification = cloneDeep(
                                ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!]?.dataVerification || {},
                            );
                        }

                        dataVerification![`${h}_${c}`] = c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`];
                    }

                    if (x[c]?.mc != null) {
                        if ('rs' in x[c]!.mc!) {
                            delete cfg.merge[`${x[c]!.mc!.r}_${x[c]!.mc!.c}`];
                        }
                        delete x[c]!.mc;
                    }

                    let value: Cell | null = null;
                    if (copyData[h - mth]?.[c - mtc]) {
                        value = cloneDeep(copyData[h - mth][c - mtc]);
                    }

                    if (!isNil(value) && !isNil(value.f)) {
                        let func = value.f;

                        if (offsetRow > 0) {
                            func = `=${functionCopy(func, 'down', offsetRow)}`;
                        }

                        if (offsetRow < 0) {
                            func = `=${functionCopy(func, 'up', Math.abs(offsetRow))}`;
                        }

                        if (offsetCol > 0) {
                            func = `=${functionCopy(func, 'right', offsetCol)}`;
                        }

                        if (offsetCol < 0) {
                            func = `=${functionCopy(func, 'left', Math.abs(offsetCol))}`;
                        }

                        const funcV = execfunction(ctx, func, h, c, undefined, undefined, true, undefined, resolver);

                        [, value.v, value.f] = funcV;

                        if (!isNil(value.ct) && !isNil(value.ct.fa)) {
                            value.m = update(value.ct.fa, funcV[1]);
                        } else {
                            value.m = update('General', funcV[1]);
                        }
                    }

                    x[c] = cloneDeep(value);

                    const cellMc = x[c]?.mc;
                    if (value != null && copyHasMC && cellMc) {
                        const valueMc = value.mc;
                        if (cellMc.rs != null && valueMc != null) {
                            cellMc.r = h;
                            cellMc.c = c;

                            cfg.merge[`${h}_${c}`] = {
                                r: cellMc.r,
                                c: cellMc.c,
                                rs: cellMc.rs,
                                cs: cellMc.cs ?? 1,
                            };

                            offsetMC[`${valueMc.r}_${valueMc.c}`] = [cellMc.r, cellMc.c];
                        } else if (valueMc != null) {
                            x[c] = {
                                mc: {
                                    r: offsetMC[`${valueMc.r}_${valueMc.c}`][0],
                                    c: offsetMC[`${valueMc.r}_${valueMc.c}`][1],
                                },
                            };
                        }
                    }
                }
                d[h] = x;
            }
        }
    }

    // check whether the copy range has conditional formatting and data validation
    let cdformat: ConditionalFormatRule[] | undefined;
    if (copyRange.copyRange.length === 1) {
        const c_file = ctx.sheets[getSheetIndex(ctx, copySheetIndex) as number];
        const a_file = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number];

        const ruleArr_cf = cloneDeep(c_file.conditionalFormatRules);

        if (!isNil(ruleArr_cf) && ruleArr_cf.length > 0) {
            cdformat = cloneDeep(a_file.conditionalFormatRules) ?? [];

            for (let i = 0; i < ruleArr_cf.length; i += 1) {
                const cf_range = ruleArr_cf[i].cellrange;

                const emptyRange: SingleRange[] = [];

                for (let th = 1; th <= timesH; th += 1) {
                    for (let tc = 1; tc <= timesC; tc += 1) {
                        mth = minh + (th - 1) * copyh;
                        mtc = minc + (tc - 1) * copyc;
                        maxrowCache = minh + th * copyh;
                        maxcellCahe = minc + tc * copyc;

                        for (let j = 0; j < cf_range.length; j += 1) {
                            const range = cfSplitRange(
                                cf_range[j],
                                { row: [c_r1, c_r2], column: [c_c1, c_c2] },
                                { row: [mth, maxrowCache - 1], column: [mtc, maxcellCahe - 1] },
                                'operatePart',
                            );

                            emptyRange.push(...range);
                        }
                    }
                }

                if (emptyRange.length > 0) {
                    ruleArr_cf[i].cellrange = emptyRange;
                    cdformat.push(ruleArr_cf[i]);
                }
            }
        }
    }

    last.row = [minh, maxh];
    last.column = [minc, maxc];

    file.config = cfg;
    file.conditionalFormatRules = cdformat;
    file.dataVerification = cloneDeep({ ...file.dataVerification, ...dataVerification });

    // if the selection contains hyperlinks
    if (ctx.selections?.length === 1 && ctx.copyState?.copyRange.length === 1) {
        forEach(ctx.copyState?.copyRange, (range) => {
            for (let r = 0; r <= range.row[1] - range.row[0]; r += 1) {
                for (let c = 0; c <= range.column[1] - range.column[0]; c += 1) {
                    const index = getSheetIndex(ctx, ctx.copyState?.dataSheetId as string) as number;
                    if (
                        ctx.sheets[index]!.data![r + range.row[0]][c + range.column[0]]?.hl &&
                        ctx.sheets[index].hyperlink![`${r}_${c}`]
                    ) {
                        setCellHyperlink(
                            ctx,
                            ctx.copyState?.dataSheetId as string,
                            r + ctx.selections![0].row[0],
                            c + ctx.selections![0].column[0],
                            ctx.sheets[index].hyperlink![`${r}_${c}`],
                        );
                    }
                }
            }
        });
    }

    jfrefreshgrid(ctx, d, ctx.selections);
}

function handleFormulaStringPaste(ctx: Context, formulaStr: string) {
    // plaintext formula is applied only to one cell
    const r = ctx.selections![0].row[0];
    const c = ctx.selections![0].column[0];

    const funcV = execfunction(ctx, formulaStr, r, c, undefined, undefined, true);

    const val = funcV[1];

    const d = getFlowdata(ctx);
    if (!d) return;

    if (!d[r][c]) d[r][c] = {};
    d[r][c]!.m = val == null ? '' : val.toString();
    d[r][c]!.v = val;
    d[r][c]!.f = formulaStr;
}

export function handlePaste(ctx: Context, e: ClipboardEvent) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (selectionCache.isPasteAction) {
        ctx.editingCellPosition = [];
        selectionCache.isPasteAction = false;

        const { clipboardData } = e;
        if (!clipboardData) return;

        let txtdata = clipboardData.getData('text/html') || clipboardData.getData('text/plain');

        // if the content is marked as copied from this sheet, check whether the clipboard matches what was copied from the current page
        let isEqual = true;
        if (
            txtdata.indexOf('fortune-copy-action-table') > -1 &&
            ctx.copyState?.copyRange != null &&
            ctx.copyState.copyRange.length > 0
        ) {
            // parse clipboard content
            const cpDataArr = [];

            const reg = /<tr.*?>(.*?)<\/tr>/g;
            const reg2 = /<td.*?>(.*?)<\/td>/g;

            const regArr = txtdata.match(reg) || [];

            for (let i = 0; i < regArr.length; i += 1) {
                const cpRowArr = [];

                const reg2Arr = regArr[i].match(reg2);

                if (!isNil(reg2Arr)) {
                    for (let j = 0; j < reg2Arr.length; j += 1) {
                        const cpValue = reg2Arr[j].replace(/<td.*?>/g, '').replace(/<\/td>/g, '');
                        cpRowArr.push(cpValue);
                    }
                }

                cpDataArr.push(cpRowArr);
            }

            // content of the copy area on the current page
            const copy_r1 = ctx.copyState.copyRange[0].row[0];
            const copy_r2 = ctx.copyState.copyRange[0].row[1];
            const copy_c1 = ctx.copyState.copyRange[0].column[0];
            const copy_c2 = ctx.copyState.copyRange[0].column[1];

            const copy_index = ctx.copyState.dataSheetId;

            let d: CellMatrix | null | undefined;
            if (copy_index === ctx.currentSheetId) {
                d = getFlowdata(ctx);
            } else {
                const index = getSheetIndex(ctx, copy_index);
                if (isNil(index)) return;
                d = ctx.sheets[index].data;
            }
            if (!d) return;

            for (let r = copy_r1; r <= copy_r2; r += 1) {
                if (r - copy_r1 > cpDataArr.length - 1) {
                    break;
                }

                for (let c = copy_c1; c <= copy_c2; c += 1) {
                    const cell = d[r][c];
                    let isInlineStr = false;
                    if (!isNil(cell) && !isNil(cell.mc) && isNil(cell.mc.rs)) {
                        continue;
                    }

                    let v: Cell['v'] | undefined;
                    if (!isNil(cell)) {
                        if ((cell.ct?.fa?.indexOf('w') ?? -1) > -1) {
                            v = d[r]?.[c]?.v;
                        } else {
                            v = d[r]?.[c]?.m;
                        }
                    } else {
                        v = '';
                    }

                    if (isNil(v) && d[r]?.[c]?.ct?.t === 'inlineStr') {
                        v = d[r]![c]!.ct!.s!.map((val: InlineStringSegment) => val.v).join('');
                        isInlineStr = true;
                    }
                    if (isNil(v)) {
                        v = '';
                    }
                    if (!isInlineStr) {
                        if (trim(cpDataArr[r - copy_r1][c - copy_c1]) !== trim(String(v))) {
                            isEqual = false;
                            break;
                        }
                    }
                }
            }
        }

        const locale_fontjson = en.fontjson;

        if (ctx.hooks.beforePaste?.(ctx.selections, txtdata) === false) {
            return;
        }

        if (
            txtdata.indexOf('fortune-copy-action-table') > -1 &&
            ctx.copyState?.copyRange != null &&
            ctx.copyState.copyRange.length > 0 &&
            isEqual
        ) {
            // clipboard content matches what was copied from luckysheet itself
            if (ctx.pasteIsCut) {
                ctx.pasteIsCut = false;
                pasteHandlerOfCutPaste(ctx, ctx.copyState);
                ctx.formulaRangeSelections = [];
            } else {
                pasteHandlerOfCopyPaste(ctx, ctx.copyState);
            }
        } else if (txtdata.indexOf('fortune-copy-action-image') > -1) {
        } else {
            if (txtdata.indexOf('table') > -1) {
                const ele = document.createElement('div');
                ele.innerHTML = txtdata;

                const trList = ele.querySelectorAll('table tr');
                if (trList.length === 0) {
                    ele.remove();
                    return;
                }

                const data = new Array(trList.length);
                let colLen = 0;
                forEach(trList[0].querySelectorAll('td'), (td) => {
                    let colspan = td.colSpan;
                    if (Number.isNaN(colspan)) {
                        colspan = 1;
                    }
                    colLen += colspan;
                });

                for (let i = 0; i < data.length; i += 1) {
                    data[i] = new Array(colLen);
                }

                let r = 0;
                const borderInfo: CellBorderMap = {};
                const styleInner = ele.querySelectorAll('style')[0]?.innerHTML || '';
                const patternReg = /{([^}]*)}/g;
                const patternStyle = styleInner.match(patternReg);
                const nameReg = /^[^\t].*/gm;
                const patternName = initial(styleInner.match(nameReg));
                const allStyleList: Record<string, string> =
                    patternName.length === patternStyle?.length && typeof patternName === typeof patternStyle
                        ? fromPairs(zip(patternName, patternStyle))
                        : {};

                const index = getSheetIndex(ctx, ctx.currentSheetId);
                if (!isNil(index)) {
                    if (isNil(ctx.sheets[index].config)) {
                        ctx.sheets[index].config = {};
                    }
                    if (isNil(ctx.sheets[index].config!.rowlen)) {
                        ctx.sheets[index].config!.rowlen = {};
                    }
                    const rowHeightList = ctx.sheets[index].config!.rowlen!;
                    forEach(trList, (tr) => {
                        let c = 0;
                        const targetR = ctx.selections![0].row[0] + r;

                        const targetRowHeight = !isNil(tr.getAttribute('height'))
                            ? parseInt(tr.getAttribute('height') as string, 10)
                            : null;
                        if (
                            (has(ctx.sheets[index].config!.rowlen, targetR) &&
                                ctx.sheets[index].config!.rowlen![targetR] !== targetRowHeight) ||
                            (!has(ctx.sheets[index].config!.rowlen, targetR) &&
                                ctx.sheets[index].defaultRowHeight !== targetRowHeight)
                        ) {
                            rowHeightList[targetR] = targetRowHeight as number;
                        }

                        forEach(tr.querySelectorAll('td'), (td) => {
                            // build cell from td
                            const { className } = td;
                            const cell: Cell = {};
                            const txt = td.innerText || td.innerHTML;
                            if (trim(txt).length === 0) {
                                cell.v = undefined;
                                cell.m = '';
                            } else {
                                const mask = genarate(txt);
                                [cell.m, cell.ct, cell.v] = mask;
                            }
                            const styleString =
                                typeof allStyleList[`.${className}`] === 'string'
                                    ? allStyleList[`.${className}`]
                                          .substring(1, allStyleList[`.${className}`].length - 1)
                                          .split('\n\t')
                                    : [];
                            const styles: Record<string, string> = {};
                            forEach(styleString, (s) => {
                                const styleList = s.split(':');
                                styles[styleList[0]] = styleList?.[1].replace(';', '');
                            });
                            if (!isNil(styles.border)) td.style.border = styles.border;
                            let bg: string | undefined = td.style.backgroundColor || styles.background;
                            if (bg === 'rgba(0, 0, 0, 0)' || isEmpty(bg)) {
                                bg = undefined;
                            }

                            cell.bg = bg;

                            const fontWight = td.style.fontWeight;
                            cell.bl =
                                (fontWight.toString() === '400' || fontWight === 'normal' || isEmpty(fontWight)) &&
                                !includes(styles['font-style'], 'bold') &&
                                (!styles['font-weight'] || styles['font-weight'] === '400')
                                    ? 0
                                    : 1;

                            cell.it =
                                (td.style.fontStyle === 'normal' || isEmpty(td.style.fontStyle)) &&
                                !includes(styles['font-style'], 'italic')
                                    ? 0
                                    : 1;

                            cell.un = !includes(styles['text-decoration'], 'underline') ? undefined : 1;

                            cell.cl = !includes(td.innerHTML, '<s>') ? undefined : 1;

                            const ff = td.style.fontFamily || styles['font-family'] || '';
                            const ffs = ff.split(',');
                            for (let i = 0; i < ffs.length; i += 1) {
                                const faKey = trim(ffs[i].toLowerCase());
                                const fa: number | undefined = (locale_fontjson as Record<string, number>)[faKey];
                                if (isNil(fa)) {
                                    cell.ff = 0;
                                } else {
                                    cell.ff = fa;
                                    break;
                                }
                            }
                            const fs = Math.round(
                                styles['font-size']
                                    ? parseInt(styles['font-size'].replace('pt', ''), 10)
                                    : (parseInt(td.style.fontSize || '13', 10) * 72) / 96,
                            );
                            cell.fs = fs;

                            cell.fc = td.style.color || styles.color;

                            const ht = td.style.textAlign || styles['text-align'] || 'left';
                            if (ht === 'center') {
                                cell.ht = 0;
                            } else if (ht === 'right') {
                                cell.ht = 2;
                            } else {
                                cell.ht = 1;
                            }

                            const regex = /vertical-align:\s*(.*?);/;
                            const tdStyle = allStyleList.td;
                            const tdMatch = tdStyle ? tdStyle.match(regex) : null;
                            const vt =
                                td.style.verticalAlign ||
                                styles['vertical-align'] ||
                                (tdMatch && tdMatch.length > 0 && tdMatch[1]) ||
                                'top';
                            if (vt === 'middle') {
                                cell.vt = 0;
                            } else if (vt === 'top' || vt === 'text-top') {
                                cell.vt = 1;
                            } else {
                                cell.vt = 2;
                            }

                            if ('mso-rotate' in styles) {
                                const rt = styles['mso-rotate'];
                                cell.rt = parseFloat(rt);
                            }

                            while (c < colLen && !isNil(data[r][c])) {
                                c += 1;
                            }

                            if (c === colLen) {
                                return true;
                            }

                            if (isNil(data[r][c])) {
                                data[r][c] = cell;
                                let rowspan = parseInt(td.getAttribute('rowspan') ?? '1', 10);
                                let colspan = parseInt(td.getAttribute('colspan') ?? '1', 10);

                                if (Number.isNaN(rowspan)) {
                                    rowspan = 1;
                                }

                                if (Number.isNaN(colspan)) {
                                    colspan = 1;
                                }

                                const r_ab = ctx.selections![0].row[0] + r;
                                const c_ab = ctx.selections![0].column[0] + c;

                                for (let rp = 0; rp < rowspan; rp += 1) {
                                    for (let cp = 0; cp < colspan; cp += 1) {
                                        if (rp === 0) {
                                            const bt = td.style.borderTop;
                                            if (!isEmpty(bt) && bt.substring(0, 3).toLowerCase() !== '0px') {
                                                const width = td.style.borderTopWidth;
                                                const type = td.style.borderTopStyle;
                                                const color = td.style.borderTopColor;
                                                const borderconfig = getQKBorder(width, type, color);

                                                if (!borderInfo[`${r + rp}_${c + cp}`]) {
                                                    borderInfo[`${r + rp}_${c + cp}`] = {};
                                                }

                                                borderInfo[`${r + rp}_${c + cp}`].t = borderconfig;
                                            }
                                        }

                                        if (rp === rowspan - 1) {
                                            const bb = td.style.borderBottom;
                                            if (!isEmpty(bb) && bb.substring(0, 3).toLowerCase() !== '0px') {
                                                const width = td.style.borderBottomWidth;
                                                const type = td.style.borderBottomStyle;
                                                const color = td.style.borderBottomColor;
                                                const borderconfig = getQKBorder(width, type, color);

                                                if (!borderInfo[`${r + rp}_${c + cp}`]) {
                                                    borderInfo[`${r + rp}_${c + cp}`] = {};
                                                }

                                                borderInfo[`${r + rp}_${c + cp}`].b = borderconfig;
                                            }
                                        }

                                        if (cp === 0) {
                                            const bl = td.style.borderLeft;
                                            if (!isEmpty(bl) && bl.substring(0, 3).toLowerCase() !== '0px') {
                                                const width = td.style.borderLeftWidth;
                                                const type = td.style.borderLeftStyle;
                                                const color = td.style.borderLeftColor;
                                                const borderconfig = getQKBorder(width, type, color);

                                                if (!borderInfo[`${r + rp}_${c + cp}`]) {
                                                    borderInfo[`${r + rp}_${c + cp}`] = {};
                                                }

                                                borderInfo[`${r + rp}_${c + cp}`].l = borderconfig;
                                            }
                                        }

                                        if (cp === colspan - 1) {
                                            const br = td.style.borderRight;
                                            if (!isEmpty(br) && br.substring(0, 3).toLowerCase() !== '0px') {
                                                const width = td.style.borderRightWidth;
                                                const type = td.style.borderRightStyle;
                                                const color = td.style.borderRightColor;
                                                const borderconfig = getQKBorder(width, type, color);

                                                if (!borderInfo[`${r + rp}_${c + cp}`]) {
                                                    borderInfo[`${r + rp}_${c + cp}`] = {};
                                                }

                                                borderInfo[`${r + rp}_${c + cp}`].r = borderconfig;
                                            }
                                        }

                                        if (rp === 0 && cp === 0) {
                                            continue;
                                        }

                                        data[r + rp][c + cp] = { mc: { r: r_ab, c: c_ab } };
                                    }
                                }

                                if (rowspan > 1 || colspan > 1) {
                                    const first = { rs: rowspan, cs: colspan, r: r_ab, c: c_ab };
                                    data[r][c].mc = first;
                                }
                            }
                            c += 1;
                            if (c === colLen) {
                                return true;
                            }
                            return true;
                        });

                        r += 1;
                    });
                    setRowHeight(ctx, rowHeightList);
                }

                ctx.formulaRangeSelections = [];
                pasteHandler(ctx, data, borderInfo);
                ele.remove();
            }
            // the copied content is an image
            else if (clipboardData.files.length === 1 && clipboardData.files[0].type.indexOf('image') > -1) {
            } else {
                txtdata = clipboardData.getData('text/plain');
                const isExcelFormula = txtdata.startsWith('=');

                if (isExcelFormula) {
                    handleFormulaStringPaste(ctx, txtdata);
                } else {
                    pasteHandler(ctx, txtdata);
                }
            }
        }
    } else if (ctx.editingCellPosition.length > 0) {
        // prevent default paste behaviour
        e.preventDefault();

        const { clipboardData } = e;
        const text = clipboardData?.getData('text/plain');
        if (text) {
            document.execCommand('insertText', false, text);
        }
    }
}

export function handlePasteByClick(ctx: Context, clipboardData: string, triggerType?: string) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (ctx.hooks.beforePaste?.(ctx.selections, clipboardData) === false) {
        return;
    }

    // If we have an internal copy/cut save, use that
    if (ctx.copyState?.copyRange != null && ctx.copyState.copyRange.length > 0) {
        if (ctx.pasteIsCut) {
            ctx.pasteIsCut = false;
            pasteHandlerOfCutPaste(ctx, ctx.copyState);
        } else {
            pasteHandlerOfCopyPaste(ctx, ctx.copyState);
        }
    } else if (clipboardData && triggerType !== 'btn') {
        const isExcelFormula = clipboardData.startsWith('=');
        if (isExcelFormula) {
            handleFormulaStringPaste(ctx, clipboardData);
        } else {
            pasteHandler(ctx, clipboardData);
        }
    }
}
