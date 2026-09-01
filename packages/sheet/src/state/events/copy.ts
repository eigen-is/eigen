import { isEmpty, isNil } from 'es-toolkit/compat';
import { cancelPaintModel, checkCF, getComputeMap, getSheetIndex } from '..';
import { type Context, getSheetConfig } from '../context';
import { copy, selectIsOverlap } from '../modules/selection';
import { hasPartMC } from '../modules/validation';

export function handleCopy(ctx: Context): boolean {
    // if format-painter is active during copy, cancel it
    if (ctx.formatPainterOn) {
        cancelPaintModel(ctx);
    }

    const selection = ctx.selections;
    if (!selection || isEmpty(selection)) {
        return false;
    }

    // warn if the copy range contains partially merged cells
    if (getSheetConfig(ctx)?.merge != null) {
        let has_PartMC = false;

        for (let s = 0; s < selection.length; s += 1) {
            const r1 = selection[s].row[0];
            const r2 = selection[s].row[1];
            const c1 = selection[s].column[0];
            const c2 = selection[s].column[1];

            has_PartMC = hasPartMC(ctx, r1, r2, c1, c2);

            if (has_PartMC) {
                break;
            }
        }

        if (has_PartMC) {
            return false;
        }
    }

    // warn when multiple selections have conditional formatting
    const cdformat = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number].conditionalFormatRules;
    if (!isNil(ctx.selections) && ctx.selections.length > 1 && !isNil(cdformat) && cdformat.length > 0) {
        let hasCF = false;

        const cf_compute = getComputeMap(ctx);

        for (let s = 0; s < ctx.selections.length; s += 1) {
            if (hasCF) {
                break;
            }

            const r1 = ctx.selections[s].row[0];
            const r2 = ctx.selections[s].row[1];
            const c1 = ctx.selections[s].column[0];
            const c2 = ctx.selections[s].column[1];

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
            return false;
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
            if (selection[s].column[0] !== str_c || selection[s].column[1] !== end_c) {
                isSameCol = false;
            }
        }

        if ((!isSameRow && !isSameCol) || selectIsOverlap(ctx)) {
            return false;
        }
    }

    copy(ctx);

    ctx.pasteIsCut = false;
    return true;
}
