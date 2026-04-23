import * as _ from "es-toolkit/compat";
import { Context } from "../context";
import { GlobalCache } from "../types";

let mouseWheelUniqueTimeout: ReturnType<typeof setTimeout>;
let scrollLockTimeout: ReturnType<typeof setTimeout>;

export function handleGlobalWheel(
    ctx: Context,
    e: WheelEvent,
    cache: GlobalCache,
    scrollbarX: HTMLDivElement,
    scrollbarY: HTMLDivElement
) {
    if (cache.searchDialog?.mouseEnter && ctx.showSearch && ctx.showReplace)
        return;
    if (ctx.filterContextMenu != null) return;
    let {scrollLeft} = scrollbarX;
    const {scrollTop} = scrollbarY;
    let visibledatacolumn_c = ctx.visibledatacolumn;
    let visibledatarow_c = ctx.visibledatarow;

    clearTimeout(mouseWheelUniqueTimeout);
    clearTimeout(scrollLockTimeout);

    if (cache.visibleColumnsUnique != null) {
        visibledatacolumn_c = cache.visibleColumnsUnique;
    } else {
        visibledatacolumn_c = _.uniq(visibledatacolumn_c);
        cache.visibleColumnsUnique = visibledatacolumn_c;
    }

    if (cache.visibleRowsUnique != null) {
        visibledatarow_c = cache.visibleRowsUnique;
    } else {
        visibledatarow_c = _.uniq(visibledatarow_c);
        cache.visibleRowsUnique = visibledatarow_c;
    }

    const row_st = _.sortedIndex(visibledatarow_c, scrollTop) + 1;

    let rowscroll = 0;

    const scrollNum = 1;

    // Scroll three rows or columns at a time
    if (e.deltaY !== 0 && !cache.verticalScrollLock) {
        cache.horizontalScrollLock = true;
        let row_ed;
        let step = Math.round(scrollNum / ctx.zoomRatio);
        step = step < 1 ? 1 : step;
        if (e.deltaY > 0) {
            row_ed = row_st + step;

            if (row_ed >= visibledatarow_c.length) {
                row_ed = visibledatarow_c.length - 1;
            }
        } else {
            row_ed = row_st - step;

            if (row_ed < 0) {
                row_ed = 0;
            }
        }

        rowscroll = row_ed === 0 ? 0 : visibledatarow_c[row_ed - 1];

        // Let the browser control scroll boundaries via the scrollbar
        scrollbarY.scrollTop = rowscroll;
    } else if (e.deltaX !== 0 && !cache.horizontalScrollLock) {
        cache.verticalScrollLock = true;
        if (e.deltaX > 0) {
            scrollLeft += 20 * ctx.zoomRatio;
        } else {
            scrollLeft -= 20 * ctx.zoomRatio;
        }

        // Let the browser control scroll boundaries via the scrollbar
        scrollbarX.scrollLeft = scrollLeft;
    }

    mouseWheelUniqueTimeout = setTimeout(() => {
        delete cache.visibleColumnsUnique;
        delete cache.visibleRowsUnique;
    }, 500);

    scrollLockTimeout = setTimeout(() => {
        delete cache.verticalScrollLock;
        delete cache.horizontalScrollLock;
    }, 50);

    e.preventDefault();
}
