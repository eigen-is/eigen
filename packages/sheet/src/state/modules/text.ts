// Measures and lays out a cell's text for the canvas: the font set it draws in, where its lines wrap, and where each
// piece of text sits, a rich cell's runs included. The painter lays out here on its grid's canvas, and a commit fits its
// row on measuringContext. Measurements are cached until a font slice loads, when the font watcher clears them and tells
// the grids to redraw. The cell editors ask for the slices of the text being typed, so a commit measures the real face.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { cellFontName, cellFontSize, SHEET_DEFAULT_FONT } from '@workspace/lib/sheets';
import { isEmpty, isNil } from 'es-toolkit/compat';
import { cellWrapsText } from '../../engine/format';
import type { Cell, CellStyle } from '../../engine/types';
import type { Context } from '../context';
import type { SheetConfig } from '../types';
import { normalizedCellAttr } from './cell';
import { isInlineStringCell, runStyleOf } from './inline-string';

type LineSegment = {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    fs: number;
};

type MeasureTextMetrics = Pick<TextMetrics, 'width' | 'actualBoundingBoxAscent' | 'actualBoundingBoxDescent'>;

// One piece of a rich cell's text, with the font and decoration it draws in. The wrap pass fills `measureText`.
type InlineRun = {
    fontset: string;
    fc: string;
    cl: number;
    un: number;
    wrap?: boolean;
    fs: number;
    v?: string;
    measureText?: MeasureTextMetrics;
};

// What a wrapped rich cell breaks between: a space, one CJK character, or a run of anything else. The
// wrap pass breaks a line after a space or a wide character, as it does in plain text.
const CJK = '\\u3000-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef';
const WRAP_WORDS = new RegExp(` |[${CJK}]|[^ ${CJK}]+`, 'g');

// One piece of laid-out text. `style` is an InlineRun in a rich cell and the font string in a plain one.
export type CellTextWordGroup = {
    content: string;
    style: InlineRun | string;
    width: number;
    height: number;
    left: number;
    top: number;
    asc?: number;
    desc?: number;
    fs?: number;
    inline?: boolean;
    wrap?: boolean;
    splitIndex?: number;
    colIndex?: number;
    cancelLine?: LineSegment;
    underLine?: LineSegment[];
};

export type CellTextInfoOption = {
    r: number;
    c: number;
    cellWidth?: number;
    cellHeight?: number;
    space_width?: number;
    space_height?: number;
};

export type CellTextInfo = {
    values: CellTextWordGroup[];
    type?: 'verticalWrap' | 'plainWrap' | 'plain';
    textWidthAll?: number;
    textHeightAll?: number;
    rotate?: number;
    textLeftAll?: number;
    textTopAll?: number;
    asc?: number;
    desc?: number;
};

type DrawLineOption = {
    left: number;
    top: number;
    width: number;
    height: number;
    asc: number;
    desc: number;
    fs: number;
};

function sameInlineLook(a: InlineRun, b: InlineRun) {
    return a.fontset === b.fontset && a.fc === b.fc && a.cl === b.cl && a.un === b.un && a.fs === b.fs;
}

function checkWordByteLength(value: string) {
    return Math.ceil(value.charCodeAt(0).toString(2).length / 8);
}

let measureTextCache: Record<string, MeasureTextMetrics> = {};

// A font slice that loads changes what the text measures, so the font watcher clears the cache when one arrives.
export function clearMeasureTextCache() {
    measureTextCache = {};
}

// WebKit fires no loadingdone for the slices a canvas draw fetches, but a face's loaded promise settles in every
// browser. A face that fails to load settles too, and its text then draws in the next face of its stack. The faces
// one frame needs arrive over several frames, so the watcher waits for the set's ready promise and tells the grids
// once for all of them. It lives at module scope because most faces, such as the CJK slices, never load in a
// session: a reaction chained per grid would keep that grid's workbook alive for the page's lifetime.
const watchedFaces = new WeakSet<FontFace>();
const fontListeners = new Set<() => void>();
let waitingForFonts = false;

// Each call also watches the faces added to the page since the last one.
export function watchFontFaces(listener: () => void) {
    for (const face of document.fonts) {
        if (face.status === 'loaded' || watchedFaces.has(face)) continue;
        watchedFaces.add(face);
        face.loaded.then(onFaceSettled, onFaceSettled);
    }
    fontListeners.add(listener);
    return () => {
        fontListeners.delete(listener);
    };
}

function onFaceSettled() {
    if (waitingForFonts) return;
    waitingForFonts = true;
    document.fonts.ready.then(() => {
        waitingForFonts = false;
        clearMeasureTextCache();
        for (const listener of fontListeners) listener();
    });
}

export function defaultFont() {
    return getFontSet(null);
}

export function getFontSet(format: CellStyle | null | undefined) {
    const style = format?.it ? 'italic' : 'normal';
    const weight = format?.bl ? 'bold' : 'normal';
    const family = getFontFamily(cellFontName(format?.ff) ?? SHEET_DEFAULT_FONT.name);
    return `${style} normal ${weight} ${cellFontSize(format?.fs)}pt ${family}`;
}

// A face loads only the unicode-range slices its text needs. A wrapped cell's row height is measured once, when the
// cell commits. So an editor loads the cell's font for its text as the user types, and the commit measures the real
// face.
export function loadCellFont(cell: CellStyle | null | undefined, text: string) {
    document.fonts.load(getFontSet(cell), text).catch(() => {});
}

let measuring: CanvasRenderingContext2D | null = null;

// The context for a measure outside a draw, such as a commit fitting its row. Every measure sets the font it needs
// first, and no draw uses this context, so a value it keeps can't disagree with what a grid shows.
export function measuringContext() {
    measuring ??= document.createElement('canvas').getContext('2d');
    return measuring;
}

// Grows a row to show a cell's text whole, the height a commit or a format stores for every reader. The painter lays
// the text out in the cell's text box, 2 px smaller than the cell each way, and 2 px in from the box's edge. A row sized
// by hand stays, and a row another cell made taller stays too.
export function growRowToFit(ctx: Context, config: SheetConfig, cell: Cell, r: number, c: number) {
    if (config.customHeight?.[r]) return;
    const measuring = measuringContext();
    if (!measuring) return;
    const cellWidth = (config.columnlen?.[c] ?? ctx.defaultcollen) - 2;
    const textHeight = getCellTextInfo(cell, measuring, { r, c, cellWidth })?.textHeightAll;
    if (textHeight == null) return;
    const height = Math.ceil(textHeight) + 4;
    if (height > (config.rowlen?.[r] ?? ctx.defaultrowlen)) (config.rowlen ??= {})[r] = height;
}

// Measures one piece of text in the canvas's current font, or in `fontset` when the caller passes it.
// Headers pass row numbers, and a cell value can be a boolean, so the value is turned into a string.
// A caller that has just set the font should pass it as `fontset`. Reading `renderCtx.font` back makes
// the browser rebuild the font string, which costs far more than the cache lookup. The key holds the
// baseline as well, because the ascent and descent below depend on it.
export function getMeasureText(
    value: string | number | boolean,
    renderCtx: CanvasRenderingContext2D,
    fontset?: string,
): MeasureTextMetrics {
    const font = fontset || renderCtx.font;
    const baseline = renderCtx.textBaseline;
    const key = `${value}_${font}_${baseline}`;
    const cached = measureTextCache[key];
    if (cached != null) {
        return cached;
    }
    if (fontset) {
        renderCtx.font = fontset;
    }

    const measured = renderCtx.measureText(String(value));
    const metrics = {
        width: measured.width,
        actualBoundingBoxAscent: measured.actualBoundingBoxAscent,
        actualBoundingBoxDescent: measured.actualBoundingBoxDescent,
    };

    // Text without a descender gets the descent of letters like g and y, so every line of one font sits alike.
    if (baseline === 'alphabetic') {
        const noDescender = renderCtx.measureText('abcdABCD');
        if (metrics.actualBoundingBoxDescent <= noDescender.actualBoundingBoxDescent) {
            metrics.actualBoundingBoxDescent = renderCtx.measureText('gjpqy').actualBoundingBoxDescent;
        }
    }

    measureTextCache[key] = metrics;
    return metrics;
}

export function drawLineInfo(
    wordGroup: CellTextWordGroup,
    cancelLine: string | number,
    underLine: string | number,
    option: DrawLineOption,
) {
    const { left, top, width, asc, desc, fs } = option;

    if (wordGroup.wrap === true) {
        return;
    }

    if (wordGroup.inline === true && wordGroup.style != null && typeof wordGroup.style !== 'string') {
        cancelLine = wordGroup.style.cl;
        underLine = wordGroup.style.un;
    }

    if (Number(cancelLine) !== 0) {
        wordGroup.cancelLine = {
            startX: left,
            startY: top - asc / 2 + 1,
            endX: left + width,
            endY: top - asc / 2 + 1,
            fs,
        };
    }

    const nUnderline = Number(underLine);
    if (nUnderline !== 0) {
        wordGroup.underLine = [];
        if (nUnderline === 1 || nUnderline === 2) {
            wordGroup.underLine.push({
                startX: left,
                startY: top + 3,
                endX: left + width,
                endY: top + 3,
                fs,
            });
        }

        if (nUnderline === 2) {
            wordGroup.underLine.push({
                startX: left,
                startY: top + desc,
                endX: left + width,
                endY: top + desc,
                fs,
            });
        }

        if (nUnderline === 3 || nUnderline === 4) {
            wordGroup.underLine.push({
                startX: left,
                startY: top + desc,
                endX: left + width,
                endY: top + desc,
                fs,
            });
        }

        if (nUnderline === 4) {
            wordGroup.underLine.push({
                startX: left,
                startY: top + desc + 2,
                endX: left + width,
                endY: top + desc + 2,
                fs,
            });
        }
    }
}

// Lays out the cell's text for the painter, or returns null when the cell has no value. Without `option.cellWidth`
// it computes only the totals. Without `option.cellHeight` the caller fits the row to the text, so a plain cell's
// wrapped lines are all laid out rather than only those that fit the row.
export function getCellTextInfo(
    cell: Cell,
    renderCtx: CanvasRenderingContext2D,
    option: CellTextInfoOption,
): CellTextInfo | null {
    const cellWidth = option.cellWidth ?? 0;
    const cellHeight = option.cellHeight ?? 0;
    const linesFitIn = option.cellHeight ?? Number.POSITIVE_INFINITY;
    const space_width = option.space_width ?? 2;
    const space_height = option.space_height ?? 2;
    const isMode = option.cellWidth == null ? 'onlyWidth' : '';

    const horizonAlign = normalizedCellAttr(cell, 'ht');
    const verticalAlign = normalizedCellAttr(cell, 'vt');

    const wrap = cellWrapsText(cell);
    // Signed degrees in [-90, 90], where positive turns the text up, or 'vertical' for stacked text.
    const rtRaw = normalizedCellAttr(cell, 'rt');
    const isVertical = rtRaw === 'vertical';
    let rt: number = typeof rtRaw === 'number' && rtRaw >= -90 && rtRaw <= 90 ? rtRaw : 0;
    const isRotateUp = rt >= 0 ? 1 : 0;

    renderCtx.textAlign = 'start';

    const textContent: CellTextInfo = { values: [] };

    let fontset = '';
    let cancelLine: string | number = '0';
    let underLine: string | number = '0';
    let fontSize = 11;
    let isInline = false;
    let value: string | number | boolean | undefined;
    const inlineStringArr: InlineRun[] = [];
    if (isInlineStringCell(cell)) {
        for (const run of cell.ct.s) {
            const runStyle = runStyleOf(run);
            const { fc, cl, un, fs } = runStyle;
            const style = { fontset: getFontSet(runStyle), fc, cl, un, fs };
            const lines = (run.v ?? '').split(/\r\n|&#13;&#10;|\r|\n/);
            for (const [index, line] of lines.entries()) {
                const isLast = index === lines.length - 1;
                if (line !== '' || isLast) {
                    const words = wrap ? (line.match(WRAP_WORDS) ?? [line]) : [line];
                    for (const word of words) inlineStringArr.push({ ...style, v: word });
                }
                if (!isLast) inlineStringArr.push({ ...style, wrap: true });
            }
        }
        isInline = true;
    } else {
        fontset = getFontSet(cell);
        renderCtx.font = fontset;

        cancelLine = normalizedCellAttr(cell, 'cl');
        underLine = normalizedCellAttr(cell, 'un');
        fontSize = cellFontSize(cell.fs);

        value = cell.m;
        if (isNil(value)) {
            value = cell.v;
        }

        if (isEmpty(value)) {
            return null;
        }
    }

    if (isVertical) {
        renderCtx.textBaseline = 'top';

        let textW_all = 0;
        let textH_all = 0;
        let colIndex = 0;
        let textH_all_cache = 0;
        const textH_all_Column: Record<number, CellTextWordGroup[]> = {};
        const textH_all_ColumnHeight: number[] = [];
        if (isInline) {
            let preShareCell: InlineRun | null = null;
            for (let i = 0; i < inlineStringArr.length; i += 1) {
                const shareCell = inlineStringArr[i];
                let value1 = shareCell.v ?? '';
                let showValue = shareCell.v ?? '';
                if (shareCell.wrap === true) {
                    value1 = 'M';
                    showValue = '';

                    if (!isNil(preShareCell) && preShareCell.wrap !== true && i < inlineStringArr.length - 1) {
                        textH_all_ColumnHeight.push(textH_all_cache);
                        textH_all_cache = 0;
                        colIndex += 1;

                        preShareCell = shareCell;
                        continue;
                    }
                }

                const measureText = getMeasureText(value1, renderCtx, shareCell.fontset);

                const textW = measureText.width + space_width;
                const textH = measureText.actualBoundingBoxAscent + measureText.actualBoundingBoxDescent + space_height;

                textH_all_cache += textH;

                if (wrap && !shareCell.wrap) {
                    if (textH_all_cache > cellHeight && !isNil(textH_all_Column[colIndex])) {
                        textH_all_ColumnHeight.push(textH_all_cache - textH);
                        textH_all_cache = textH;
                        colIndex += 1;
                    }
                }

                if (i === inlineStringArr.length - 1) {
                    textH_all_ColumnHeight.push(textH_all_cache);
                }

                if (isNil(textH_all_Column[colIndex])) {
                    textH_all_Column[colIndex] = [];
                }

                const item = {
                    content: showValue,
                    style: shareCell,
                    width: textW,
                    height: textH,
                    left: 0,
                    top: 0,
                    colIndex,
                    asc: measureText.actualBoundingBoxAscent,
                    desc: measureText.actualBoundingBoxDescent,
                    inline: true,
                    wrap: false,
                };

                if (shareCell.wrap === true) {
                    item.wrap = true;
                }

                textH_all_Column[colIndex].push(item);
                preShareCell = shareCell;
            }
        } else {
            const valueStr = String(value);
            const measureText = getMeasureText(valueStr, renderCtx, fontset);
            const textHeight = measureText.actualBoundingBoxDescent + measureText.actualBoundingBoxAscent;

            const vArr: string[] = valueStr.length > 1 ? valueStr.split('') : [valueStr];
            const oneWordWidth = getMeasureText(vArr[0], renderCtx, fontset).width;

            for (let i = 0; i < vArr.length; i += 1) {
                const textW = oneWordWidth + space_width;
                const textH = textHeight + space_height;

                textH_all_cache += textH;

                if (wrap) {
                    if (textH_all_cache > cellHeight && !isNil(textH_all_Column[colIndex])) {
                        textH_all_ColumnHeight.push(textH_all_cache - textH);
                        textH_all_cache = textH;
                        colIndex += 1;
                    }
                }

                if (i === vArr.length - 1) {
                    textH_all_ColumnHeight.push(textH_all_cache);
                }

                if (isNil(textH_all_Column[colIndex])) {
                    textH_all_Column[colIndex] = [];
                }

                textH_all_Column[colIndex].push({
                    content: vArr[i],
                    style: fontset,
                    width: textW,
                    height: textH,
                    left: 0,
                    top: 0,
                    colIndex,
                    asc: measureText.actualBoundingBoxAscent,
                    desc: measureText.actualBoundingBoxDescent,
                });
            }
        }

        const textH_all_ColumWidth: number[] = [];
        for (let i = 0; i < textH_all_ColumnHeight.length; i += 1) {
            const columnHeight = textH_all_ColumnHeight[i];
            const col = textH_all_Column[i];
            let colMaxW = 0;
            for (let c = 0; c < col.length; c += 1) {
                const word = col[c];
                colMaxW = Math.max(colMaxW, word.width);
            }
            textH_all_ColumWidth.push(colMaxW);
            textW_all += colMaxW;
            textH_all = Math.max(textH_all, columnHeight);
        }

        textContent.type = 'verticalWrap';
        textContent.textWidthAll = textW_all;
        textContent.textHeightAll = textH_all;

        if (isMode === 'onlyWidth') {
            return textContent;
        }

        let cumColumnWidth = 0;
        for (let i = 0; i < textH_all_ColumnHeight.length; i += 1) {
            const columnHeight = textH_all_ColumnHeight[i];
            const columnWidth = textH_all_ColumWidth[i];

            const col = textH_all_Column[i];
            let cumWordHeight = 0;
            for (let c = 0; c < col.length; c += 1) {
                const word = col[c];

                let left = space_width + cumColumnWidth;
                if (horizonAlign === '0') {
                    left = cellWidth / 2 + cumColumnWidth - textW_all / 2 + space_width * textH_all_ColumnHeight.length;
                } else if (horizonAlign === '2') {
                    left = cellWidth + cumColumnWidth - textW_all + space_width;
                }

                let top = cellHeight - space_height + cumWordHeight - columnHeight;
                if (verticalAlign === '0') {
                    top = cellHeight / 2 + cumWordHeight - columnHeight / 2;
                } else if (verticalAlign === '1') {
                    top = space_height + cumWordHeight;
                }

                cumWordHeight += word.height;

                word.left = left;
                word.top = top;

                drawLineInfo(word, cancelLine, underLine, {
                    width: columnWidth,
                    height: word.height,
                    left,
                    top: top + word.height - space_height,
                    asc: word.height,
                    desc: 0,
                    fs: fontSize,
                });

                textContent.values.push(word);
            }

            cumColumnWidth += columnWidth;
        }
    } else {
        renderCtx.textBaseline = 'alphabetic';

        if (wrap || isInline) {
            let textW_all = 0;
            let textH_all = 0;
            let textW_all_inner = 0;

            let splitIndex = 0;
            const text_all_split: Record<number, CellTextWordGroup[]> = {};

            textContent.rotate = rt;
            rt = Math.abs(rt);

            let anchor = 0;
            let preStr = '';
            let preTextHeight = 0;
            let preTextWidth = 0;
            let preMeasureText: MeasureTextMetrics | undefined;
            let i = 1;
            // Where a line may break: after a space or a multi-byte character. An overflow goes back to it.
            let spaceOrTwoByte: {
                index: number;
                str: string;
                width: number;
                height: number;
                asc: number;
                desc: number;
            } | null = null;
            let spaceOrTwoByteIndex: number | null = null;
            // A rich cell's word is measured once, however often the wrap pass goes back over it.
            const measureRun = (sc: InlineRun): MeasureTextMetrics => {
                if (sc.measureText == null) {
                    sc.measureText = getMeasureText(sc.v ?? '', renderCtx, sc.fontset);
                }
                return sc.measureText;
            };

            // Puts a word of a rich cell on the line being filled. A word in the same style as the one
            // before it joins that piece, so right-to-left text draws in its own order and the canvas
            // kerns across the join.
            const addWord = (sc: InlineRun) => {
                const m = measureRun(sc);
                const height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
                const line = (text_all_split[splitIndex] ??= []);
                const last = line.at(-1);
                if (last && typeof last.style !== 'string' && sameInlineLook(last.style, sc)) {
                    last.content += sc.v ?? '';
                    last.width += m.width;
                    last.height = Math.max(last.height, height);
                    last.asc = Math.max(last.asc ?? 0, m.actualBoundingBoxAscent);
                    last.desc = Math.max(last.desc ?? 0, m.actualBoundingBoxDescent);
                    return;
                }
                line.push({
                    content: sc.v ?? '',
                    style: sc,
                    width: m.width,
                    height,
                    left: 0,
                    top: 0,
                    splitIndex,
                    asc: m.actualBoundingBoxAscent,
                    desc: m.actualBoundingBoxDescent,
                    inline: true,
                    fs: sc.fs,
                });
            };

            if (isInline) {
                // The line being filled holds the items from anchor up to i. Its size grows with each item
                // and starts again at a line break, so a long cell costs one pass.
                let lineWidth = 0;
                let lineHeight = 0;
                while (i <= inlineStringArr.length) {
                    const run = inlineStringArr[i - 1];
                    if (run.wrap === true) {
                        if (i - 1 > anchor) {
                            for (let s = anchor; s < i - 1; s += 1) addWord(inlineStringArr[s]);
                        } else {
                            const measureText = getMeasureText('M', renderCtx, run.fontset);
                            (text_all_split[splitIndex] ??= []).push({
                                content: '',
                                style: run,
                                width: measureText.width,
                                height: measureText.actualBoundingBoxAscent + measureText.actualBoundingBoxDescent,
                                left: 0,
                                top: 0,
                                splitIndex,
                                asc: measureText.actualBoundingBoxAscent,
                                desc: measureText.actualBoundingBoxDescent,
                                inline: true,
                                wrap: true,
                                fs: run.fs,
                            });
                        }
                        splitIndex += 1;
                        anchor = i;
                        i += 1;
                        lineWidth = 0;
                        lineHeight = 0;
                        spaceOrTwoByteIndex = null;
                        continue;
                    }

                    const m = measureRun(run);
                    lineWidth += m.width;
                    lineHeight = Math.max(lineHeight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
                    const rtPI = (rt * Math.PI) / 180;
                    // The line's box, its height included, as it stands rotated.
                    const width = lineWidth * Math.cos(rtPI) + lineHeight * Math.sin(rtPI);
                    const height = lineWidth * Math.sin(rtPI) + lineHeight * Math.cos(rtPI);

                    const word = run.v ?? '';
                    if (word === ' ' || checkWordByteLength(word) === 2) {
                        spaceOrTwoByteIndex = i;
                    }

                    // A rotated line runs out of the cell's height, a level one out of its width.
                    const overflows = rt !== 0 ? height + space_height > cellHeight : width + space_width > cellWidth;
                    if (wrap && overflows && !isNil(text_all_split[splitIndex])) {
                        const end =
                            !isNil(spaceOrTwoByteIndex) && spaceOrTwoByteIndex < i ? spaceOrTwoByteIndex : i - 1;
                        for (let s = anchor; s < end; s += 1) addWord(inlineStringArr[s]);
                        anchor = end;
                        i = end + 1;
                        splitIndex += 1;
                        spaceOrTwoByteIndex = null;
                        lineWidth = 0;
                        lineHeight = 0;
                    } else if (i === inlineStringArr.length) {
                        for (let s = anchor; s < i; s += 1) addWord(inlineStringArr[s]);
                        break;
                    } else {
                        text_all_split[splitIndex] ??= [];
                        i += 1;
                    }
                }
            } else {
                const valueStr = String(value);
                let parsedTextHeight = 0;
                while (i <= valueStr.length) {
                    const str = valueStr.substring(anchor, i);
                    const measureText = getMeasureText(str, renderCtx, fontset);
                    const textWidth = measureText.width;
                    const textHeight = measureText.actualBoundingBoxAscent + measureText.actualBoundingBoxDescent;

                    const width =
                        textWidth * Math.cos((rt * Math.PI) / 180) + textHeight * Math.sin((rt * Math.PI) / 180);

                    const height =
                        textWidth * Math.sin((rt * Math.PI) / 180) + textHeight * Math.cos((rt * Math.PI) / 180);
                    const lastWord = str.substr(str.length - 1, 1);
                    if (lastWord === ' ' || checkWordByteLength(lastWord) === 2) {
                        spaceOrTwoByte = {
                            index: i,
                            str,
                            width,
                            height,
                            asc: measureText.actualBoundingBoxAscent,
                            desc: measureText.actualBoundingBoxDescent,
                        };
                    }
                    if (rt !== 0) {
                        if (height + space_height > cellHeight && !isNil(text_all_split[splitIndex])) {
                            if (!isNil(spaceOrTwoByte) && spaceOrTwoByte.index < i) {
                                anchor = spaceOrTwoByte.index;

                                i = spaceOrTwoByte.index + 1;

                                text_all_split[splitIndex].push({
                                    content: spaceOrTwoByte.str,
                                    style: fontset,
                                    width: spaceOrTwoByte.width,
                                    height: spaceOrTwoByte.height,
                                    left: 0,
                                    top: 0,
                                    splitIndex,
                                    asc: spaceOrTwoByte.asc,
                                    desc: spaceOrTwoByte.desc,
                                    fs: fontSize,
                                });

                                splitIndex += 1;

                                spaceOrTwoByte = null;
                            } else {
                                anchor = i - 1;

                                text_all_split[splitIndex].push({
                                    content: preStr,
                                    style: fontset,
                                    left: 0,
                                    top: 0,
                                    splitIndex,
                                    height: preTextHeight,
                                    width: preTextWidth,
                                    asc: measureText.actualBoundingBoxAscent,
                                    desc: measureText.actualBoundingBoxDescent,
                                    fs: fontSize,
                                });

                                splitIndex += 1;
                            }
                        } else if (i === valueStr.length) {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            text_all_split[splitIndex].push({
                                content: str,
                                style: fontset,
                                left: 0,
                                top: 0,
                                splitIndex,
                                height: textHeight,
                                width: textWidth,
                                asc: measureText.actualBoundingBoxAscent,
                                desc: measureText.actualBoundingBoxDescent,
                                fs: fontSize,
                            });
                            break;
                        } else {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            i += 1;
                        }
                    } else {
                        if (width + space_width > cellWidth && !isNil(text_all_split[splitIndex])) {
                            if (!isNil(spaceOrTwoByte) && spaceOrTwoByte.index < i) {
                                anchor = spaceOrTwoByte.index;

                                i = spaceOrTwoByte.index + 1;

                                text_all_split[splitIndex].push({
                                    content: spaceOrTwoByte.str,
                                    style: fontset,
                                    width: spaceOrTwoByte.width,
                                    height: spaceOrTwoByte.height,
                                    left: 0,
                                    top: 0,
                                    splitIndex,
                                    asc: spaceOrTwoByte.asc,
                                    desc: spaceOrTwoByte.desc,
                                    fs: fontSize,
                                });

                                splitIndex += 1;
                                spaceOrTwoByte = null;

                                parsedTextHeight += preTextHeight;
                                if (parsedTextHeight >= linesFitIn) break;
                            } else {
                                spaceOrTwoByte = null;
                                anchor = i - 1;

                                if (preMeasureText == null) break;
                                text_all_split[splitIndex].push({
                                    content: preStr,
                                    style: fontset,
                                    width: preTextWidth,
                                    height: preTextHeight,
                                    left: 0,
                                    top: 0,
                                    splitIndex,
                                    asc: preMeasureText.actualBoundingBoxAscent,
                                    desc: preMeasureText.actualBoundingBoxDescent,
                                    fs: fontSize,
                                });
                                splitIndex += 1;

                                parsedTextHeight += preTextHeight;
                                if (parsedTextHeight >= linesFitIn) break;
                            }
                        } else if (i === valueStr.length) {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            text_all_split[splitIndex].push({
                                content: str,
                                style: fontset,
                                width: textWidth,
                                height: textHeight,
                                left: 0,
                                top: 0,
                                splitIndex,
                                asc: measureText.actualBoundingBoxAscent,
                                desc: measureText.actualBoundingBoxDescent,
                                fs: fontSize,
                            });

                            break;
                        } else {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            i += 1;
                        }
                    }

                    preStr = str;
                    preTextHeight = textHeight;
                    preTextWidth = textWidth;
                    preMeasureText = measureText;
                }
            }

            const split_all_size = [];
            let oneLinemaxWordCount = 0;
            const splitLen = Object.keys(text_all_split).length;
            if (splitLen === 0) return textContent;
            for (let j = 0; j < splitLen; j += 1) {
                const splitLists = text_all_split[j];
                if (isNil(splitLists)) {
                    continue;
                }
                let sWidth = 0;
                let sHeight = 0;
                let maxDesc = 0;
                let maxAsc = 0;
                let lineHeight = 0;
                let maxWordCount = 0;
                for (let s = 0; s < splitLists.length; s += 1) {
                    const sp = splitLists[s];
                    const spDesc = sp.desc ?? 0;
                    const spAsc = sp.asc ?? 0;
                    sWidth += sp.width;
                    sHeight = Math.max(sHeight, sp.height - spDesc);
                    maxDesc = Math.max(maxDesc, spDesc);
                    maxAsc = Math.max(maxAsc, spAsc);
                    maxWordCount += 1;
                }

                lineHeight = sHeight / 2;
                oneLinemaxWordCount = Math.max(oneLinemaxWordCount, maxWordCount);
                if (rt !== 0) {
                    sHeight += lineHeight;
                    textW_all_inner = Math.max(textW_all_inner, sWidth);
                    textH_all += sHeight;
                } else {
                    sHeight += lineHeight;
                    textW_all = Math.max(textW_all, sWidth);
                    textH_all += sHeight;
                }

                split_all_size.push({
                    width: sWidth,
                    height: sHeight,
                    desc: maxDesc,
                    asc: maxAsc,
                    lineHeight,
                    wordCount: maxWordCount,
                });
            }
            let cumWordHeight = 0;
            let cumColumnWidth = 0;
            const rtPI = (rt * Math.PI) / 180;
            const lastLine = split_all_size[splitLen - 1];
            const lastLineSpaceHeight = lastLine.lineHeight;
            textH_all = textH_all - lastLineSpaceHeight + lastLine.desc;
            const rw = textH_all / Math.sin(rtPI) + textW_all_inner * Math.cos(rtPI);
            const rh = textW_all_inner * Math.sin(rtPI);
            let fixOneLineLeft = 0;

            if (rt !== 0) {
                if (splitLen === 1) {
                    textW_all = textW_all_inner + 2 * (textH_all / Math.tan(rtPI));
                    fixOneLineLeft = textH_all / Math.tan(rtPI);
                } else {
                    textW_all = textW_all_inner + textH_all / Math.tan(rtPI);
                }
                textContent.textWidthAll = rw;
                textContent.textHeightAll = rh;
            } else {
                textContent.textWidthAll = textW_all;
                textContent.textHeightAll = textH_all;
            }

            if (isMode === 'onlyWidth') {
                return textContent;
            }

            if (rt !== 0 && Number(isRotateUp) === 1) {
                renderCtx.textAlign = 'end';
                for (let j = 0; j < splitLen; j += 1) {
                    const splitLists = text_all_split[j];
                    if (isNil(splitLists)) {
                        continue;
                    }
                    const size = split_all_size[j];

                    cumColumnWidth = 0;

                    for (let c = splitLists.length - 1; c >= 0; c -= 1) {
                        const wordGroup = splitLists[c];
                        let left = 0;
                        let top = 0;
                        if (rt !== 0) {
                            const y = cumWordHeight + size.asc;
                            const x = cumWordHeight / Math.tan(rtPI) - cumColumnWidth + textW_all_inner;
                            if (horizonAlign === '0') {
                                // center
                                if (verticalAlign === '0') {
                                    // mid
                                    left =
                                        x + cellWidth / 2 - textW_all / 2 + (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y + cellHeight / 2 - textH_all / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left = x + cellWidth / 2 - textW_all / 2;
                                    top = y - (textH_all / 2 - rh / 2);
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left = x + cellWidth / 2 - textW_all / 2 + lastLineSpaceHeight * Math.cos(rtPI);
                                    top =
                                        y + cellHeight - rh / 2 - textH_all / 2 - lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            } else if (horizonAlign === '1') {
                                // left
                                if (verticalAlign === '0') {
                                    // mid
                                    left = x - (rh * Math.sin(rtPI)) / 2 + (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y +
                                        cellHeight / 2 +
                                        (rh * Math.cos(rtPI)) / 2 -
                                        (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left = x - rh * Math.sin(rtPI);
                                    top = y + rh * Math.cos(rtPI);
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left = x + lastLineSpaceHeight * Math.cos(rtPI);
                                    top = y + cellHeight - lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            } else if (horizonAlign === '2') {
                                // right
                                if (verticalAlign === '0') {
                                    // mid
                                    left =
                                        x +
                                        cellWidth -
                                        rw / 2 -
                                        (textW_all_inner / 2 + textH_all / 2 / Math.tan(rtPI)) +
                                        (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y + cellHeight / 2 - textH_all / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left = x + cellWidth - textW_all + fixOneLineLeft;
                                    top = y - textH_all;
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left = x + cellWidth - rw * Math.cos(rtPI) + lastLineSpaceHeight * Math.cos(rtPI);
                                    top = y + cellHeight - rw * Math.sin(rtPI) - lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            }
                        }

                        wordGroup.left = left;
                        wordGroup.top = top;

                        drawLineInfo(wordGroup, cancelLine, underLine, {
                            width: wordGroup.width,
                            height: wordGroup.height,
                            left: left - wordGroup.width,
                            top,
                            asc: size.asc,
                            desc: size.desc,
                            fs: wordGroup.fs ?? fontSize,
                        });

                        textContent.values.push(wordGroup);

                        cumColumnWidth += wordGroup.width;
                    }

                    cumWordHeight += size.height;
                }
            } else {
                for (let j = 0; j < splitLen; j += 1) {
                    const splitLists = text_all_split[j];
                    if (isNil(splitLists)) {
                        continue;
                    }
                    const size = split_all_size[j];

                    cumColumnWidth = 0;

                    for (let c = 0; c < splitLists.length; c += 1) {
                        const wordGroup = splitLists[c];
                        let left = 0;
                        let top = 0;
                        if (rt !== 0) {
                            const y = cumWordHeight + size.asc;
                            const x = (textH_all - cumWordHeight) / Math.tan(rtPI) + cumColumnWidth;

                            if (horizonAlign === '0') {
                                // center
                                if (verticalAlign === '0') {
                                    // mid
                                    left =
                                        x + cellWidth / 2 - textW_all / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y + cellHeight / 2 - textH_all / 2 + (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left =
                                        x + cellWidth / 2 - textW_all / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top = y - (textH_all / 2 - rh / 2) + (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left = x + cellWidth / 2 - textW_all / 2 - lastLineSpaceHeight * Math.cos(rtPI);
                                    top =
                                        y + cellHeight - rh / 2 - textH_all / 2 - lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            } else if (horizonAlign === '1') {
                                // left
                                if (verticalAlign === '0') {
                                    // mid
                                    left = x - (rh * Math.sin(rtPI)) / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y -
                                        textH_all +
                                        cellHeight / 2 -
                                        (rh * Math.cos(rtPI)) / 2 -
                                        (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left = x;
                                    top = y - textH_all;
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left = x - rh * Math.sin(rtPI) - lastLineSpaceHeight * Math.cos(rtPI);
                                    top =
                                        y -
                                        textH_all +
                                        cellHeight -
                                        rh * Math.cos(rtPI) -
                                        lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            } else if (horizonAlign === '2') {
                                // right
                                if (verticalAlign === '0') {
                                    // mid
                                    left =
                                        x +
                                        cellWidth -
                                        rw / 2 -
                                        textW_all / 2 -
                                        (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                    top =
                                        y + cellHeight / 2 - textH_all / 2 - (lastLineSpaceHeight * Math.cos(rtPI)) / 2;
                                } else if (verticalAlign === '1') {
                                    // top
                                    left = x + cellWidth - rw * Math.cos(rtPI);
                                    top = y + rh * Math.cos(rtPI);
                                } else if (verticalAlign === '2') {
                                    // bottom
                                    left =
                                        x +
                                        cellWidth -
                                        textW_all -
                                        lastLineSpaceHeight * Math.cos(rtPI) +
                                        fixOneLineLeft;
                                    top = y + cellHeight - lastLineSpaceHeight * Math.cos(rtPI);
                                }
                            }

                            drawLineInfo(wordGroup, cancelLine, underLine, {
                                width: wordGroup.width,
                                height: wordGroup.height,
                                left,
                                top,
                                asc: size.asc,
                                desc: size.desc,
                                fs: wordGroup.fs ?? fontSize,
                            });
                        } else {
                            left = space_width + cumColumnWidth;
                            if (horizonAlign === '0') {
                                left = cellWidth / 2 + cumColumnWidth - size.width / 2;
                            } else if (horizonAlign === '2') {
                                left = cellWidth + cumColumnWidth - size.width;
                            }

                            top = cellHeight - space_height + cumWordHeight + size.asc - textH_all;
                            if (verticalAlign === '0') {
                                top = cellHeight / 2 + cumWordHeight - textH_all / 2 + size.asc;
                            } else if (verticalAlign === '1') {
                                top = space_height + cumWordHeight + size.asc;
                            }

                            drawLineInfo(wordGroup, cancelLine, underLine, {
                                width: wordGroup.width,
                                height: wordGroup.height,
                                left,
                                top,
                                asc: size.asc,
                                desc: size.desc,
                                fs: wordGroup.fs ?? fontSize,
                            });
                        }

                        wordGroup.left = left;
                        wordGroup.top = top;

                        textContent.values.push(wordGroup);

                        cumColumnWidth += wordGroup.width;
                    }

                    cumWordHeight += size.height;
                }
            }

            textContent.type = 'plainWrap';

            if (rt !== 0) {
                if (horizonAlign === '0') {
                    // center
                    textContent.textLeftAll = cellWidth / 2;
                    if (verticalAlign === '0') {
                        // mid
                        textContent.textTopAll = cellHeight / 2;
                    } else if (verticalAlign === '1') {
                        // top
                        textContent.textTopAll = rh / 2;
                    } else if (verticalAlign === '2') {
                        // bottom
                        textContent.textTopAll = cellHeight - rh / 2;
                    }
                } else if (horizonAlign === '1') {
                    // left
                    if (verticalAlign === '0') {
                        // mid
                        textContent.textLeftAll = 0;
                        textContent.textTopAll = cellHeight / 2;
                    } else if (verticalAlign === '1') {
                        // top
                        textContent.textLeftAll = 0;
                        textContent.textTopAll = 0;
                    } else if (verticalAlign === '2') {
                        // bottom
                        textContent.textLeftAll = 0;
                        textContent.textTopAll = cellHeight;
                    }
                } else if (horizonAlign === '2') {
                    // right
                    if (verticalAlign === '0') {
                        // mid
                        textContent.textLeftAll = cellWidth - rw / 2;
                        textContent.textTopAll = cellHeight / 2;
                    } else if (verticalAlign === '1') {
                        // top
                        textContent.textLeftAll = cellWidth;
                        textContent.textTopAll = 0;
                    } else if (verticalAlign === '2') {
                        // bottom
                        textContent.textLeftAll = cellWidth;
                        textContent.textTopAll = cellHeight;
                    }
                }
            }
        } else {
            const valueStr = String(value);
            const measureText = getMeasureText(valueStr, renderCtx, fontset);
            const textWidth = measureText.width;
            const textHeight = measureText.actualBoundingBoxDescent + measureText.actualBoundingBoxAscent;

            textContent.rotate = rt;

            rt = Math.abs(rt);
            const rtPI = (rt * Math.PI) / 180;

            const textWidthAll = textWidth * Math.cos(rtPI) + textHeight * Math.sin(rtPI);

            const textHeightAll = textWidth * Math.sin(rtPI) + textHeight * Math.cos(rtPI);

            if (rt !== 0) {
                textContent.textHeightAll = textHeightAll;
            } else {
                textContent.textHeightAll =
                    textHeightAll + textHeight / 2 - measureText.actualBoundingBoxDescent - space_height;
            }
            textContent.textWidthAll = textWidthAll;

            if (isMode === 'onlyWidth') {
                return textContent;
            }

            const width = textWidthAll;
            const height = textHeightAll;

            let left = space_width + textHeight * Math.sin(rtPI) * isRotateUp;
            if (horizonAlign === '0') {
                left = cellWidth / 2 - width / 2 + textHeight * Math.sin(rtPI) * isRotateUp;
            } else if (horizonAlign === '2') {
                left = cellWidth - space_width - width + textHeight * Math.sin(rtPI) * isRotateUp;
            }

            let top =
                cellHeight -
                space_height -
                height +
                measureText.actualBoundingBoxAscent * Math.cos(rtPI) +
                textWidth * Math.sin(rtPI) * isRotateUp;
            if (verticalAlign === '0') {
                top =
                    cellHeight / 2 -
                    height / 2 +
                    measureText.actualBoundingBoxAscent * Math.cos(rtPI) +
                    textWidth * Math.sin(rtPI) * isRotateUp;
            } else if (verticalAlign === '1') {
                top =
                    space_height +
                    measureText.actualBoundingBoxAscent * Math.cos(rtPI) +
                    textWidth * Math.sin(rtPI) * isRotateUp;
            }

            textContent.type = 'plain';

            const wordGroup: CellTextWordGroup = {
                content: valueStr,
                style: fontset,
                width,
                height,
                left,
                top,
            };

            drawLineInfo(wordGroup, cancelLine, underLine, {
                width: textWidth,
                height: textHeight,
                left,
                top,
                asc: measureText.actualBoundingBoxAscent,
                desc: measureText.actualBoundingBoxDescent,
                fs: fontSize,
            });

            textContent.values.push(wordGroup);

            textContent.textLeftAll = left;
            textContent.textTopAll = top;

            textContent.asc = measureText.actualBoundingBoxAscent;
            textContent.desc = measureText.actualBoundingBoxDescent;
        }
    }
    return textContent;
}
