import {isEmpty, isNil} from "es-toolkit/compat";
import {cancelPaintModel, checkCF, getComputeMap, getSheetIndex} from "..";
import {Context} from "../context";
import {copy, selectIsOverlap} from "../modules/selection";
import {hasPartMC} from "../modules/validation";

export function handleCopy(ctx: Context) {
    // if (imageCtrl.currentImgId != null) {
    //   imageCtrl.copyImgItem(event);
    //   return;
    // }

    // // if format-painter is active during copy, cancel it
    if (ctx.luckysheetPaintModelOn) {
        cancelPaintModel(ctx);
    }

    const selection = ctx.luckysheet_select_save;
    if (!selection || isEmpty(selection)) {
        return;
    }

    // warn if the copy range contains partially merged cells
    if (ctx.config.merge != null) {
        let has_PartMC = false;

        for (let s = 0; s < selection.length; s += 1) {
            const r1 = selection[s].row[0];
            const r2 = selection[s].row[1];
            const c1 = selection[s].column[0];
            const c2 = selection[s].column[1];

            has_PartMC = hasPartMC(ctx, ctx.config, r1, r2, c1, c2);

            if (has_PartMC) {
                break;
            }
        }

        if (has_PartMC) {
            // if (isEditMode()) {
            //   alert(locale_drag.noMerge);
            // } else {
            //   tooltip.info(locale_drag.noMerge, "");
            // }
            return;
        }
    }

    // warn when multiple selections have conditional formatting
    const cdformat =
        ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId) as number]
            .luckysheet_conditionformat_save;
    if (
        !isNil(ctx.luckysheet_select_save) &&
        ctx.luckysheet_select_save.length > 1 &&
        !isNil(cdformat) &&
        cdformat.length > 0
    ) {
        let hasCF = false;

        const cf_compute = getComputeMap(ctx);

        for (let s = 0; s < ctx.luckysheet_select_save.length; s += 1) {
            if (hasCF) {
                break;
            }

            const r1 = ctx.luckysheet_select_save[s].row[0];
            const r2 = ctx.luckysheet_select_save[s].row[1];
            const c1 = ctx.luckysheet_select_save[s].column[0];
            const c2 = ctx.luckysheet_select_save[s].column[1];

            for (let r = r1; r <= r2; r += 1) {
                if (hasCF) {
                    break;
                }
                for (let c = c1; c <= c2; c += 1) {
                    if (!isNil(checkCF(r, c, cf_compute))) {
                        hasCF = true;
                        break;
                    }
                }
            }
        }

        if (hasCF) {
            // if (isEditMode()) {
            //   alert(locale_drag.noMulti);
            // } else {
            //   tooltip.info(locale_drag.noMulti, "");
            // }
            return;
        }
    }

    // warn when multiple selections span different rows and columns
    if (selection.length > 1) {
        let isSameRow = true;
        const str_r = selection[0].row[0];
        const end_r = selection[0].row[1];
        let isSameCol = true;
        const str_c = selection[0].column[0];
        const end_c = selection[0].column[1];

        for (let s = 1; s < selection.length; s += 1) {
            if (selection[s].row[0] !== str_r || selection[s].row[1] !== end_r) {
                isSameRow = false;
            }
            if (
                selection[s].column[0] !== str_c ||
                selection[s].column[1] !== end_c
            ) {
                isSameCol = false;
            }
        }

        if ((!isSameRow && !isSameCol) || selectIsOverlap(ctx)) {
            // if (isEditMode()) {
            //   alert(locale_drag.noMulti);
            // } else {
            //   tooltip.info(locale_drag.noMulti, "");
            // }
            return;
        }
    }

    copy(ctx);

    ctx.luckysheet_paste_iscut = false;
}
