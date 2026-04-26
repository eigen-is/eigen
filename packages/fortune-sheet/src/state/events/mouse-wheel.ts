import {sortedIndex, uniq} from "es-toolkit/compat";
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
        visibledatacolumn_c = uniq(visibledatacolumn_c);
        cache.visibleColumnsUnique = visibledatacolumn_c;
    }

    if (cache.visibleRowsUnique != null) {
        visibledatarow_c = cache.visibleRowsUnique;
    } else {
        visibledatarow_c = uniq(visibledatarow_c);
        cache.visibleRowsUnique = visibledatarow_c;
    }

    const row_st = sortedIndex(visibledatarow_c, scrollTop) + 1;

    // Scroll one row or 20px at a time; the scrollbar clamps to bounds
    if (e.deltaY !== 0 && !cache.verticalScrollLock) {
        cache.horizontalScrollLock = true;
        let row_ed = e.deltaY > 0 ? row_st + 1 : row_st - 1;
        if (row_ed >= visibledatarow_c.length) row_ed = visibledatarow_c.length - 1;
        if (row_ed < 0) row_ed = 0;
        scrollbarY.scrollTop = row_ed === 0 ? 0 : visibledatarow_c[row_ed - 1];
    } else if (e.deltaX !== 0 && !cache.horizontalScrollLock) {
        cache.verticalScrollLock = true;
        scrollbarX.scrollLeft = scrollLeft + (e.deltaX > 0 ? 20 : -20);
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
