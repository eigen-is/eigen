import { find, set } from 'es-toolkit/compat';
import { type Context, getFlowdata } from '../context';
import type { GlobalCache } from '../types';
import { getSheetIndex } from '../utils';
import { mergeBorder } from '.';

let counter = 0;
function generateImageId() {
    return `img_${Date.now()}_${++counter}`;
}

export function saveImage(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];

    file.images = ctx.insertedImgs;
}

export function removeActiveImage(ctx: Context) {
    ctx.insertedImgs = ctx.insertedImgs?.filter((image) => image.id !== ctx.activeImg);
    ctx.activeImg = undefined;
    saveImage(ctx);
}

export function replaceImageMediaName(ctx: Context, oldName: string, newName: string) {
    if (!ctx.insertedImgs) return;
    let changed = false;
    ctx.insertedImgs = ctx.insertedImgs.map((img) => {
        if (img.mediaName !== oldName) return img;
        changed = true;
        return { ...img, mediaName: newName };
    });
    if (changed) saveImage(ctx);
}

export function removeImageByMediaName(ctx: Context, name: string) {
    if (!ctx.insertedImgs) return;
    const before = ctx.insertedImgs.length;
    ctx.insertedImgs = ctx.insertedImgs.filter((img) => img.mediaName !== name);
    if (ctx.insertedImgs.length !== before) saveImage(ctx);
}

export function insertImage(ctx: Context, mediaName: string, width: number, height: number) {
    const last = ctx.selections?.[ctx.selections.length - 1];
    let rowIndex = last?.row_focus;
    let colIndex = last?.column_focus;
    if (!last) {
        rowIndex = 0;
        colIndex = 0;
    } else {
        if (rowIndex == null) {
            [rowIndex] = last.row;
        }
        if (colIndex == null) {
            [colIndex] = last.column;
        }
    }
    const flowdata = getFlowdata(ctx);
    let left = colIndex === 0 ? 0 : ctx.visibledatacolumn[colIndex - 1];
    let top = rowIndex === 0 ? 0 : ctx.visibledatarow[rowIndex - 1];
    if (flowdata) {
        const margeset = mergeBorder(ctx, flowdata, rowIndex, colIndex);
        if (margeset) {
            [top] = margeset.row;
            [left] = margeset.column;
        }
    }
    const img = {
        id: generateImageId(),
        mediaName,
        x: left,
        y: top,
        width: width * 0.5,
        height: height * 0.5,
    };
    ctx.insertedImgs = (ctx.insertedImgs || []).concat(img);
    saveImage(ctx);
}

function getImagePosition() {
    const box = document.getElementById('luckysheet-modal-dialog-activeImage');
    if (!box) return undefined;
    const { width, height } = box.getBoundingClientRect();
    const left = box.offsetLeft;
    const top = box.offsetTop;
    return { left, top, width, height };
}

export function cancelActiveImgItem(ctx: Context, globalCache: GlobalCache) {
    ctx.activeImg = undefined;
    globalCache.image = undefined;
}

export function onImageMoveStart(_ctx: Context, globalCache: GlobalCache, e: MouseEvent) {
    const position = getImagePosition();
    if (position) {
        const { top, left } = position;
        set(globalCache, 'image', {
            cursorMoveStartPosition: { x: e.pageX, y: e.pageY },
            imgInitialPosition: { left, top },
        });
    }
}

export function onImageMove(ctx: Context, globalCache: GlobalCache, e: MouseEvent) {
    if (ctx.allowEdit === false) return false;
    const image = globalCache?.image;
    const img = document.getElementById('luckysheet-modal-dialog-activeImage');
    if (img && image && !image.resizingSide) {
        const { x: startX, y: startY } = image.cursorMoveStartPosition!;
        let { top, left } = image.imgInitialPosition!;
        left += e.pageX - startX;
        top += e.pageY - startY;
        if (top < 0) top = 0;
        (img as HTMLDivElement).style.left = `${left}px`;
        (img as HTMLDivElement).style.top = `${top}px`;
        return true;
    }
    return false;
}

export function onImageMoveEnd(ctx: Context, globalCache: GlobalCache) {
    const position = getImagePosition();
    if (!globalCache.image?.resizingSide) {
        globalCache.image = undefined;

        if (position) {
            const img = find(ctx.insertedImgs, (v) => v.id === ctx.activeImg);
            if (img) {
                img.x = position.left;
                img.y = position.top;
                saveImage(ctx);
            }
        }
    }
}

export function onImageResizeStart(globalCache: GlobalCache, e: MouseEvent, resizingSide: string) {
    const position = getImagePosition();
    if (position) {
        set(globalCache, 'image', {
            cursorMoveStartPosition: { x: e.pageX, y: e.pageY },
            resizingSide,
            imgInitialPosition: position,
        });
    }
}

export function onImageResize(ctx: Context, globalCache: GlobalCache, e: MouseEvent) {
    if (ctx.allowEdit === false) return false;
    const image = globalCache?.image;
    if (image?.resizingSide) {
        const imgContainer = document.getElementById('luckysheet-modal-dialog-activeImage');
        const img = imgContainer?.querySelector('.luckysheet-modal-dialog-content');
        if (img == null) return false;
        const { x: startX, y: startY } = image.cursorMoveStartPosition!;
        let { top, left, width, height } = image.imgInitialPosition!;
        const dx = e.pageX - startX;
        const dy = e.pageY - startY;
        const minHeight = 60;
        const minWidth = 1.5 * 60;
        if (['lm', 'lt', 'lb'].includes(image.resizingSide)) {
            if (width - dx < minWidth) {
                left += width - minWidth;
                width = minWidth;
            } else {
                left += dx;
                width -= dx;
            }
            if (left < 0) left = 0;
            (img as HTMLDivElement).style.left = `${left}px`;
            (imgContainer as HTMLDivElement).style.left = `${left}px`;
        }
        if (['rm', 'rt', 'rb'].includes(image.resizingSide)) {
            width = width + dx < minWidth ? minWidth : width + dx;
        }
        if (['mt', 'lt', 'rt'].includes(image.resizingSide)) {
            if (height - dy < minHeight) {
                top += height - minHeight;
                height = minHeight;
            } else {
                top += dy;
                height -= dy;
            }
            if (top < 0) top = 0;
            (img as HTMLDivElement).style.top = `${top}px`;
            (imgContainer as HTMLDivElement).style.top = `${top}px`;
        }
        if (['mb', 'lb', 'rb'].includes(image.resizingSide)) {
            height = height + dy < minHeight ? minHeight : height + dy;
        }
        (img as HTMLDivElement).style.width = `${width}px`;
        (imgContainer as HTMLDivElement).style.width = `${width}px`;
        (img as HTMLDivElement).style.height = `${height}px`;
        (imgContainer as HTMLDivElement).style.height = `${height}px`;
        (img as HTMLDivElement).style.backgroundSize = `${width}px ${height}px`;

        return true;
    }
    return false;
}

export function onImageResizeEnd(ctx: Context, globalCache: GlobalCache) {
    if (globalCache.image?.resizingSide) {
        globalCache.image = undefined;
        const position = getImagePosition();
        if (position) {
            const img = find(ctx.insertedImgs, (v) => v.id === ctx.activeImg);
            if (img) {
                img.x = position.left;
                img.y = position.top;
                img.width = position.width;
                img.height = position.height;
                saveImage(ctx);
            }
        }
    }
}
