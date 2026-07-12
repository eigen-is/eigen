import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { isEmpty, isNil, isPlainObject } from 'es-toolkit/compat';
import type { Cell, CellStyle } from '../../engine/types';
import type { Context } from '../context';
import { isdatatypemulti } from '.';
import { normalizedCellAttr } from './cell';
import { isInlineStringCell } from './inline-string';

// Geometry the canvas painter walks back to draw text-decoration overlays.
type LineSegment = {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    fs: number;
};

// Cached canvas text metrics. Matches the three fields we read from DOM
// `TextMetrics`, but may carry computed fallback values when the platform
// leaves `actualBoundingBoxAscent`/`Descent` unset — so we can't reuse the
// DOM type directly.
type MeasureTextMetrics = {
    width: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
};

// Inline-string run produced from `Cell['ct'].s` by the inline-cell branch below.
// Carries the resolved fontset string for the run, the colour/decoration values
// normalized to non-null defaults, and the lazily-computed measureText cache for
// the run text (filled by the wrap pass).
type InlineRun = {
    fontset: string;
    fc: string;
    cl: number;
    un: number;
    wrap?: boolean;
    fs: number;
    v?: string;
    si?: number;
    measureText?: MeasureTextMetrics;
};

// One styled run produced by the layout pass. `style` is either an InlineRun
// (when wordGroup.inline === true) or the resolved fontset string for plain text;
// `content` is the run's text or '' for wrap markers. cellTextRender narrows.
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

// Option payload for drawLineInfo — geometry of the run the decoration overlays.
type DrawLineOption = {
    left: number;
    top: number;
    width: number;
    height: number;
    asc: number;
    desc: number;
    fs: number;
};

function checkWordByteLength(value: string) {
    return Math.ceil(value.charCodeAt(0).toString(2).length / 8);
}

export function hasChinaword(s: string) {
    const patrn = /[\u4E00-\u9FA5]|[\uFE30-\uFFA0]/gi;

    if (!patrn.exec(s)) {
        return false;
    }
    return true;
}

const textHeightCache: Record<string, [number, number]> = {};
let measureTextCache: Record<string, MeasureTextMetrics> = {};
let measureTextCellInfoCache: Record<string, CellTextInfo | null> = {};

export function clearMeasureTextCache() {
    measureTextCache = {};
    measureTextCellInfoCache = {};
}

function getTextSize(text: string, font: string) {
    if (font in textHeightCache) {
        return textHeightCache[font];
    }

    const ele = document.createElement('span');
    ele.style.float = 'left';
    ele.style.whiteSpace = 'nowrap';
    ele.style.visibility = 'hidden';
    ele.style.margin = '0';
    ele.style.padding = '0';
    ele.innerHTML = text;
    document.body.append(ele);

    const w = Math.max(ele.scrollWidth, ele.offsetWidth, ele.clientWidth);
    const h = Math.max(ele.scrollHeight, ele.offsetHeight, ele.clientHeight);

    textHeightCache[font] = [w, h];

    ele.remove();
    return [w, h];
}

export function defaultFont(defaultFontSize: number) {
    return `normal normal normal ${defaultFontSize}pt "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Heiti SC",  "WenQuanYi Micro Hei", sans-serif`;
}

// `ff` is persisted either as an index into the font list (legacy numeric or
// numeric-string form) or as a family name. One decoder serves the canvas
// renderer and the toolbar picker, so they can't disagree about a cell's font.
export function resolveFontName(ff: number | string | undefined | null): string {
    if (ff == null || ff === '') return EIGEN_FONTS[0].name;
    if (isdatatypemulti(ff)) return EIGEN_FONTS[Number.parseInt(String(ff), 10)]?.name ?? EIGEN_FONTS[0].name;
    return String(ff).replace(/["']/g, '').split(',')[0]?.trim() || EIGEN_FONTS[0].name;
}

export function getFontSet(format: CellStyle | null | undefined, defaultFontSize: number) {
    if (format == null || !isPlainObject(format)) {
        return defaultFont(defaultFontSize);
    }

    const fontAttr: string[] = [];

    // font-style
    fontAttr.push(!format.it ? 'normal' : 'italic');

    // font-variant
    fontAttr.push('normal');

    // font-weight
    fontAttr.push(!format.bl ? 'normal' : 'bold');

    // font-size
    fontAttr.push(`${format.fs ? Math.ceil(format.fs) : defaultFontSize}pt`);

    const fallback = `"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif`;

    const name = resolveFontName(format.ff);
    const primary = name.includes(' ') ? `"${name}"` : name;

    return `${fontAttr.join(' ')} ${primary},${fallback}`;
}

// Get text size for cells with a value. Row/column headers pass numeric sequence
// values (`r + 1`); cell values can also be boolean (e.g. TRUE/FALSE formula
// results), all coerced via String() before measurement.
export function getMeasureText(
    value: string | number | boolean,
    renderCtx: CanvasRenderingContext2D,
    fontset?: string,
): MeasureTextMetrics {
    let mtc = measureTextCache[`${value}_${renderCtx.font}`];
    if (fontset) {
        mtc = measureTextCache[`${value}_${fontset}`];
    }

    if (mtc != null) {
        return mtc;
    }
    if (fontset) {
        renderCtx.font = fontset;
    }

    const measureText = renderCtx.measureText(String(value));
    const cache: MeasureTextMetrics = {
        width: measureText.width,
        actualBoundingBoxAscent: measureText.actualBoundingBoxAscent,
        actualBoundingBoxDescent: measureText.actualBoundingBoxDescent,
    };

    if (
        cache.actualBoundingBoxDescent == null ||
        cache.actualBoundingBoxAscent == null ||
        Number.isNaN(cache.actualBoundingBoxDescent) ||
        Number.isNaN(cache.actualBoundingBoxAscent)
    ) {
        let commonWord = 'M';
        if (hasChinaword(String(value))) {
            commonWord = '田';
        }
        const oneLineTextHeight = getTextSize(commonWord, renderCtx.font)[1] * 0.8;
        if (renderCtx.textBaseline === 'top') {
            cache.actualBoundingBoxDescent = oneLineTextHeight;
            cache.actualBoundingBoxAscent = 0;
        } else if (renderCtx.textBaseline === 'middle') {
            cache.actualBoundingBoxDescent = oneLineTextHeight / 2;
            cache.actualBoundingBoxAscent = oneLineTextHeight / 2;
        } else {
            cache.actualBoundingBoxDescent = 0;
            cache.actualBoundingBoxAscent = oneLineTextHeight;
        }
    }

    if (renderCtx.textBaseline === 'alphabetic') {
        const descText = 'gjpqy';
        const matchText = 'abcdABCD';
        let descTextMeasure: MeasureTextMetrics | TextMetrics = measureTextCache[`${descText}_${renderCtx.font}`];
        if (fontset) {
            descTextMeasure = measureTextCache[`${descText}_${fontset}`];
        }

        let matchTextMeasure: MeasureTextMetrics | TextMetrics = measureTextCache[`${matchText}_${renderCtx.font}`];
        if (fontset) {
            matchTextMeasure = measureTextCache[`${matchText}_${fontset}`];
        }

        if (descTextMeasure == null) {
            descTextMeasure = renderCtx.measureText(descText);
        }

        if (matchTextMeasure == null) {
            matchTextMeasure = renderCtx.measureText(matchText);
        }

        if (cache.actualBoundingBoxDescent <= matchTextMeasure.actualBoundingBoxDescent) {
            cache.actualBoundingBoxDescent = descTextMeasure.actualBoundingBoxDescent;
            if (!cache.actualBoundingBoxDescent) {
                cache.actualBoundingBoxDescent = 0;
            }
        }
    }

    measureTextCache[`${value}_${renderCtx.font}`] = cache;
    return cache;
}

export function isSupportBoundingBox(ctx: CanvasRenderingContext2D) {
    const measureText = ctx.measureText('田');
    if (isNil(measureText.actualBoundingBoxAscent)) {
        return false;
    }
    return true;
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

// Layout the cell's text for the canvas painter. Returns null when the cell has no value.
// `option.cellWidth` absent → "onlyWidth" mode (row-height auto-fit); only the geometry
// totals are computed and the layout math returns early. `option.cellHeight` absent is
// allowed for callers that only consume textHeightAll — the layout `values` produced
// with the default 0 are unused.
export function getCellTextInfo(
    cell: Cell,
    renderCtx: CanvasRenderingContext2D,
    sheetCtx: Context,
    option: CellTextInfoOption,
): CellTextInfo | null {
    const cellWidth = option.cellWidth ?? 0;
    const cellHeight = option.cellHeight ?? 0;
    const space_width = option.space_width ?? 2;
    const space_height = option.space_height ?? 2;
    const isMode = option.cellWidth == null ? 'onlyWidth' : '';
    const isModeSplit = isMode === 'onlyWidth' ? '_' : '';
    const textInfo = measureTextCellInfoCache[`${option.r}_${option.c}${isModeSplit}${isMode}`];
    if (textInfo) {
        return textInfo;
    }

    // Horizontal alignment
    const horizonAlign = normalizedCellAttr(cell, 'ht');
    // Vertical alignment
    const verticalAlign = normalizedCellAttr(cell, 'vt');

    const tb = normalizedCellAttr(cell, 'tb'); // wrap overflow
    // rt: signed degrees in [-90, 90] (positive = CCW / "up", negative = CW / "down"),
    // or 'vertical' for stacked text. The two branches that follow (vertical-stack vs.
    // diagonal/horizontal) stay separate; only the diagonal branch needs the magnitude
    // and direction split into Math.abs(rt) + isRotateUp.
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
        const sharedStrings = cell.ct.s;
        let similarIndex = 0;
        for (let i = 0; i < sharedStrings.length; i += 1) {
            const shareCell = sharedStrings[i];
            const scfontset = getFontSet(shareCell, sheetCtx.defaultFontSize);
            const { fc } = shareCell;
            const { cl } = shareCell;
            const { un } = shareCell;
            let { v } = shareCell;
            const { fs } = shareCell;
            v = (v ?? '')
                .replace(/\r\n/g, '_x000D_')
                .replace(/&#13;&#10;/g, '_x000D_')
                .replace(/\r/g, '_x000D_')
                .replace(/\n/g, '_x000D_');
            const splitArr = v.split('_x000D_');
            for (let x = 0; x < splitArr.length; x += 1) {
                const newValue = splitArr[x];

                if (newValue === '' && x !== splitArr.length - 1) {
                    inlineStringArr.push({
                        fontset: scfontset,
                        fc: !fc ? '#000' : fc,
                        cl: !cl ? 0 : cl,
                        un: !un ? 0 : un,
                        wrap: true,
                        fs: !fs ? 11 : fs,
                    });
                    similarIndex += 1;
                } else {
                    inlineStringArr.push({
                        fontset: scfontset,
                        fc: !fc ? '#000' : fc,
                        cl: !cl ? 0 : cl,
                        un: !un ? 0 : un,
                        v: newValue,
                        si: similarIndex,
                        fs: !fs ? 11 : fs,
                    });

                    if (x !== splitArr.length - 1) {
                        inlineStringArr.push({
                            fontset: scfontset,
                            fc: !fc ? '#000' : fc,
                            cl: !cl ? 0 : cl,
                            un: !un ? 0 : un,
                            wrap: true,
                            fs: !fs ? 11 : fs,
                        });
                        similarIndex += 1;
                    }
                }
            }

            similarIndex += 1;
        }
        isInline = true;
    } else {
        fontset = getFontSet(cell, sheetCtx.defaultFontSize);
        renderCtx.font = fontset;

        cancelLine = normalizedCellAttr(cell, 'cl'); // cancelLine
        underLine = normalizedCellAttr(cell, 'un'); // underLine
        fontSize = normalizedCellAttr(cell, 'fs');

        value = cell.m;
        if (isNil(value)) {
            value = cell.v;
        }

        if (isEmpty(value)) {
            return null;
        }
    }

    if (isVertical) {
        // vertical text (stacked top-to-bottom characters)
        renderCtx.textBaseline = 'top';

        let textW_all = 0; // Total width/height after splitting
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

                if (tb === '2' && !shareCell.wrap) {
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
            // value is non-nil here — isEmpty(value) returned null earlier.
            const valueStr = String(value);
            const measureText = getMeasureText(valueStr, renderCtx);
            const textHeight = measureText.actualBoundingBoxDescent + measureText.actualBoundingBoxAscent;

            const vArr: string[] = valueStr.length > 1 ? valueStr.split('') : [valueStr];
            const oneWordWidth = getMeasureText(vArr[0], renderCtx).width;

            for (let i = 0; i < vArr.length; i += 1) {
                const textW = oneWordWidth + space_width;
                const textH = textHeight + space_height;

                textH_all_cache += textH;

                if (tb === '2') {
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
        const supportBoundBox = isSupportBoundingBox(renderCtx);
        if (supportBoundBox) {
            renderCtx.textBaseline = 'alphabetic';
        } else {
            renderCtx.textBaseline = 'bottom';
        }

        if (tb === '2' || isInline) {
            // wrap

            let textW_all = 0; // Total width/height after splitting
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
            // Tracks the last index in `valueStr` where a wrap break is allowed (whitespace or
            // multi-byte character); the rotated/plain branches below back-track to it on overflow.
            // null when no break candidate has been seen since the last split.
            let spaceOrTwoByte: {
                index: number;
                str: string;
                width: number;
                height: number;
                asc: number;
                desc: number;
            } | null = null;
            // Inline-string variant of the wrap-break tracker — only the index is needed there.
            let spaceOrTwoByteIndex: number | null = null;
            // Lazily resolves an inline run's cached canvas metrics; the runtime fills sc.measureText
            // for non-wrap runs before any branch that reads it, but TS can't track that across the
            // while-loop boundary, so each push site routes through here.
            const measureRun = (sc: InlineRun): MeasureTextMetrics => {
                if (sc.measureText == null) {
                    sc.measureText = getMeasureText(sc.v ?? '', renderCtx, sc.fontset);
                }
                return sc.measureText;
            };

            // Build a CellTextWordGroup from an inline run; centralises the metrics
            // lookup so callers don't repeat the height = asc + desc arithmetic.
            // `splitIndex` is read at call time (closure over the outer mutable var).
            const buildItem = (sc: InlineRun): CellTextWordGroup => {
                const m = measureRun(sc);
                return {
                    content: sc.v ?? '',
                    style: sc,
                    width: m.width,
                    height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
                    left: 0,
                    top: 0,
                    splitIndex,
                    asc: m.actualBoundingBoxAscent,
                    desc: m.actualBoundingBoxDescent,
                    inline: true,
                    fs: sc.fs,
                };
            };

            if (isInline) {
                while (i <= inlineStringArr.length) {
                    const shareCells = inlineStringArr.slice(anchor, i);
                    if (shareCells[shareCells.length - 1].wrap === true) {
                        anchor = i;

                        if (shareCells.length > 1) {
                            for (let s = 0; s < shareCells.length - 1; s += 1) {
                                text_all_split[splitIndex].push(buildItem(shareCells[s]));
                            }
                        }

                        if (shareCells.length === 1) {
                            const sc = shareCells[0];
                            const measureText = getMeasureText('M', renderCtx, sc.fontset);
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            text_all_split[splitIndex].push({
                                content: '',
                                style: sc,
                                width: measureText.width,
                                height: measureText.actualBoundingBoxAscent + measureText.actualBoundingBoxDescent,
                                left: 0,
                                top: 0,
                                splitIndex,
                                asc: measureText.actualBoundingBoxAscent,
                                desc: measureText.actualBoundingBoxDescent,
                                inline: true,
                                wrap: true,
                                fs: sc.fs,
                            });
                        }

                        splitIndex += 1;

                        i += 1;

                        continue;
                    }

                    let textWidth = 0;
                    let textHeight = 0;
                    for (let s = 0; s < shareCells.length; s += 1) {
                        const sc = shareCells[s];
                        const m = measureRun(sc);
                        textWidth += m.width;
                        textHeight = Math.max(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
                    }

                    const width =
                        textWidth * Math.cos((rt * Math.PI) / 180) + textHeight * Math.sin((rt * Math.PI) / 180); // consider text box wdith and line height

                    const height =
                        textWidth * Math.sin((rt * Math.PI) / 180) + textHeight * Math.cos((rt * Math.PI) / 180); // consider text box wdith and line height

                    const lastWord = shareCells[shareCells.length - 1];
                    // Non-wrap items always have v set (see inlineStringArr.push call sites); the
                    // wrap branch above has already short-circuited so lastWord is non-wrap here.
                    const lastWordV = lastWord.v ?? '';
                    if (lastWordV === ' ' || checkWordByteLength(lastWordV) === 2) {
                        spaceOrTwoByteIndex = i;
                    }

                    if (rt !== 0) {
                        // rotate
                        if (height + space_height > cellHeight && !isNil(text_all_split[splitIndex]) && tb === '2') {
                            if (!isNil(spaceOrTwoByteIndex) && spaceOrTwoByteIndex < i) {
                                for (let s = 0; s < spaceOrTwoByteIndex - anchor; s += 1) {
                                    text_all_split[splitIndex].push(buildItem(shareCells[s]));
                                }
                                anchor = spaceOrTwoByteIndex;

                                i = spaceOrTwoByteIndex + 1;

                                splitIndex += 1;

                                spaceOrTwoByteIndex = null;
                            } else {
                                anchor = i - 1;

                                for (let s = 0; s < shareCells.length - 1; s += 1) {
                                    text_all_split[splitIndex].push(buildItem(shareCells[s]));
                                }

                                splitIndex += 1;
                            }
                        } else if (i === inlineStringArr.length) {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            for (let s = 0; s < shareCells.length; s += 1) {
                                text_all_split[splitIndex].push(buildItem(shareCells[s]));
                            }
                            break;
                        } else {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            i += 1;
                        }
                    } else {
                        // plain
                        if (width + space_width > cellWidth && !isNil(text_all_split[splitIndex]) && tb === '2') {
                            if (!isNil(spaceOrTwoByteIndex) && spaceOrTwoByteIndex < i) {
                                for (let s = 0; s < spaceOrTwoByteIndex - anchor; s += 1) {
                                    text_all_split[splitIndex].push(buildItem(shareCells[s]));
                                }
                                anchor = spaceOrTwoByteIndex;

                                i = spaceOrTwoByteIndex + 1;

                                splitIndex += 1;

                                spaceOrTwoByteIndex = null;
                            } else {
                                anchor = i - 1;

                                for (let s = 0; s < shareCells.length - 1; s += 1) {
                                    text_all_split[splitIndex].push(buildItem(shareCells[s]));
                                }

                                splitIndex += 1;
                            }
                        } else if (i === inlineStringArr.length) {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }

                            for (let s = 0; s < shareCells.length; s += 1) {
                                text_all_split[splitIndex].push(buildItem(shareCells[s]));
                            }

                            break;
                        } else {
                            if (isNil(text_all_split[splitIndex])) {
                                text_all_split[splitIndex] = [];
                            }
                            i += 1;
                        }
                    }
                }
            } else {
                // value is non-nil here — isEmpty(value) returned null earlier.
                const valueStr = String(value);
                let parsedTextHeight = 0;
                while (i <= valueStr.length) {
                    const str = valueStr.substring(anchor, i);
                    const measureText = getMeasureText(str, renderCtx);
                    const textWidth = measureText.width;
                    const textHeight = measureText.actualBoundingBoxAscent + measureText.actualBoundingBoxDescent;

                    const width =
                        textWidth * Math.cos((rt * Math.PI) / 180) + textHeight * Math.sin((rt * Math.PI) / 180); // consider text box wdith and line height

                    const height =
                        textWidth * Math.sin((rt * Math.PI) / 180) + textHeight * Math.cos((rt * Math.PI) / 180); // consider text box wdith and line height
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
                        // rotate
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
                        // plain
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
                                if (parsedTextHeight >= cellHeight) break;
                            } else {
                                spaceOrTwoByte = null;
                                anchor = i - 1;

                                // preMeasureText carries the previous iteration's metrics — set
                                // at the bottom of every iteration. The overflow branch can't
                                // fire on iteration 1 (the bucket is empty), so a missing value
                                // would indicate an inconsistency; bail to avoid a NaN push.
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
                                if (parsedTextHeight >= cellHeight) break;
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
                    if (rt !== 0) {
                        // rotate
                        sWidth += sp.width;
                        sHeight = Math.max(sHeight, sp.height - (supportBoundBox ? spDesc : 0));
                    } else {
                        // plain
                        sWidth += sp.width;
                        sHeight = Math.max(sHeight, sp.height - (supportBoundBox ? spDesc : 0));
                    }
                    maxDesc = Math.max(maxDesc, supportBoundBox ? spDesc : 0);
                    maxAsc = Math.max(maxAsc, spAsc);
                    maxWordCount += 1;
                }

                lineHeight = sHeight / 2;
                oneLinemaxWordCount = Math.max(oneLinemaxWordCount, maxWordCount);
                if (rt !== 0) {
                    // rotate
                    sHeight += lineHeight;
                    textW_all_inner = Math.max(textW_all_inner, sWidth);
                    textH_all += sHeight;
                } else {
                    // plain
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
                            // rotate
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
                                    // top fixOneLineLeft
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
                            // rotate
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
                                    // top fixOneLineLeft
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
                            // plain
                            left = space_width + cumColumnWidth;
                            if (horizonAlign === '0') {
                                // + space_width*textH_all_ColumnHeight.length
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
            // value is non-nil here — isEmpty(value) returned null earlier.
            const valueStr = String(value);
            const measureText = getMeasureText(valueStr, renderCtx);
            const textWidth = measureText.width;
            const textHeight = measureText.actualBoundingBoxDescent + measureText.actualBoundingBoxAscent;

            textContent.rotate = rt;

            rt = Math.abs(rt);
            const rtPI = (rt * Math.PI) / 180;

            const textWidthAll = textWidth * Math.cos(rtPI) + textHeight * Math.sin(rtPI); // consider text box wdith and line height

            const textHeightAll = textWidth * Math.sin(rtPI) + textHeight * Math.cos(rtPI); // consider text box wdith and line height

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

            let left = space_width + textHeight * Math.sin(rtPI) * isRotateUp; // Default: left-align (ht=1)
            if (horizonAlign === '0') {
                // Center-align
                left = cellWidth / 2 - width / 2 + textHeight * Math.sin(rtPI) * isRotateUp;
            } else if (horizonAlign === '2') {
                // Right-align
                left = cellWidth - space_width - width + textHeight * Math.sin(rtPI) * isRotateUp;
            }

            let top =
                cellHeight -
                space_height -
                height +
                measureText.actualBoundingBoxAscent * Math.cos(rtPI) +
                textWidth * Math.sin(rtPI) * isRotateUp; // Default: bottom-align (vt=2)
            if (verticalAlign === '0') {
                // Center-align
                top =
                    cellHeight / 2 -
                    height / 2 +
                    measureText.actualBoundingBoxAscent * Math.cos(rtPI) +
                    textWidth * Math.sin(rtPI) * isRotateUp;
            } else if (verticalAlign === '1') {
                // Top-align
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
