import { indexOf, isEmpty, kebabCase } from 'es-toolkit/compat';
import type { Cell, CellMatrix, CellStyle, InlineStringSegment } from '../../engine/types';
import type { Context } from '../context';
import { getCellValue, getFontStyleByCell } from './cell';
import { selectTextContent, selectTextContentCross } from './cursor';

type InlineStringCell = Cell & { ct: { t: 'inlineStr'; s: InlineStringSegment[] } };
type InlineStringCT = { t: 'inlineStr'; s: InlineStringSegment[] };

// Mapping from Cell style-attribute keys to their CSS property names. Used by the
// inline-string CSS pipeline (parsing span styles back to cell attributes) and as
// the set of style attrs `getFontStyleByCell` / `isAllSelectedCellsInStatus` know
// about. Kept `as const` so consumers can derive `StyleAttr` and so the CSS-name
// values are literal-typed for downstream string comparisons.
export const attrToCssName = {
    bl: 'font-weight',
    it: 'font-style',
    ff: 'font-family',
    fs: 'font-size',
    fc: 'color',
    cl: 'text-decoration',
    un: 'border-bottom',
} as const;

export type StyleAttr = keyof typeof attrToCssName;

export function isStyleAttr(key: PropertyKey): key is StyleAttr {
    return typeof key === 'string' && key in attrToCssName;
}

// CamelCased counterparts of `attrToCssName`. Pre-computed (rather than
// `camelCase(attrToCssName[attr])` at runtime) so the value type is
// `keyof CSSStyleDeclaration`, which lets consumers index `element.style[...]`
// without a cast.
export const cssDomKeyForAttr = {
    bl: 'fontWeight',
    it: 'fontStyle',
    ff: 'fontFamily',
    fs: 'fontSize',
    fc: 'color',
    cl: 'textDecoration',
    un: 'borderBottom',
} as const satisfies Record<StyleAttr, keyof CSSStyleDeclaration>;

// Cell fields stamped transiently by `getCssText` for the underline (`un`) branch.
// They never persist on stored cells — only read by `getFontStyleByCell` to size /
// colour the rendered underline.
export type UnderlineHints = { _color?: string; _fontSize?: number };

export const inlineStyleAffectAttribute = {
    bl: 1,
    it: 1,
    ff: 1,
    cl: 1,
    un: 1,
    fs: 1,
    fc: 1,
};

export const inlineStyleAffectCssName = {
    'font-weight': 1,
    'font-style': 1,
    'font-family': 1,
    'text-decoration': 1,
    'border-bottom': 1,
    'font-size': 1,
    color: 1,
};

export function isInlineStringCell(cell: Cell | null | undefined): cell is InlineStringCell {
    return cell?.ct?.t === 'inlineStr' && (cell?.ct?.s?.length ?? 0) > 0;
}

export function isInlineStringCT(ct: Cell['ct'] | null | undefined): ct is InlineStringCT {
    return ct?.t === 'inlineStr' && (ct?.s?.length ?? 0) > 0;
}

export function getInlineStringNoStyle(r: number, c: number, data: CellMatrix) {
    const ct = getCellValue(r, c, data, 'ct');
    if (isInlineStringCT(ct)) {
        const strings = ct.s;
        let value = '';
        for (let i = 0; i < strings.length; i += 1) {
            const strObj = strings[i];
            if (strObj.v) {
                value += strObj.v;
            }
        }
        return value;
    }
    return '';
}

export function convertCssToStyleList(cssText: string, originCell: Cell) {
    if (isEmpty(cssText)) {
        return {};
    }
    const cssTextArray = cssText.split(';');

    const styleList: CellStyle = {
        fc: originCell.fc || '#000000',
        fs: originCell.fs || 10,
        cl: originCell.cl || 0,
        un: originCell.un || 0,
        bl: originCell.bl || 0,
        it: originCell.it || 0,
        ff: originCell.ff || 0,
    };
    for (let s of cssTextArray) {
        s = s.toLowerCase();
        const key = s.substring(0, s.indexOf(':')).trim();
        const value = s.substring(s.indexOf(':') + 1).trim();
        if (key === 'font-weight') {
            if (value === 'bold') {
                styleList.bl = 1;
            }
        }

        if (key === 'font-style') {
            if (value === 'italic') {
                styleList.it = 1;
            }
        }

        if (key === 'font-family') {
            styleList.ff = value;
        }

        if (key === 'font-size') {
            styleList.fs = parseInt(value, 10);
        }

        if (key === 'color') {
            styleList.fc = value;
        }

        if (key === 'text-decoration') {
            styleList.cl = 1;
        }

        if (key === 'border-bottom') {
            styleList.un = 1;
        }

        if (key === 'lucky-strike') {
            styleList.cl = Number(value);
        }

        if (key === 'lucky-underline') {
            styleList.un = Number(value);
        }
    }

    return styleList;
}

export function convertSpanToShareString(
    // eslint-disable-next-line no-undef
    $dom: NodeListOf<HTMLSpanElement>,
    originCell: Cell,
) {
    const styles: CellStyle[] = [];
    let preStyleList: Cell;
    let preStyleListString = null;
    for (let i = 0; i < $dom.length; i += 1) {
        const span = $dom[i];
        const styleList = convertCssToStyleList(span.style.cssText, originCell) as Cell;

        const curStyleListString = JSON.stringify(styleList);
        let v = span.innerText;
        v = v.replace(/\n/g, '\r\n');
        if (i === $dom.length - 1) {
            if (v.endsWith('\r\n') && !v.endsWith('\r\n\r\n')) {
                v = v.slice(0, v.length - 2);
            }
        }

        if (curStyleListString === preStyleListString) {
            preStyleList!.v += v;
        } else {
            styleList.v = v;
            styles.push(styleList);

            preStyleListString = curStyleListString;
            preStyleList = styleList;
        }
    }
    return styles;
}

export function updateInlineStringFormatOutside(cell: Cell, key: keyof Cell, value: unknown) {
    if (cell.ct == null) {
        return;
    }
    const { s } = cell.ct;
    if (s == null) {
        return;
    }
    for (const item of s) {
        (item as Record<string, unknown>)[key] = value;
    }
}

function getClassWithcss(cssText: string, ukey: string) {
    const cssTextArray = cssText.split(';');
    if (ukey == null || ukey.length === 0) {
        return cssText;
    }
    if (cssText.indexOf(ukey) > -1) {
        for (let i = 0; i < cssTextArray.length; i += 1) {
            let s = cssTextArray[i];
            s = s.toLowerCase();
            const key = s.substring(0, s.indexOf(':')).trim();
            const value = s.substring(s.indexOf(':') + 1).trim();
            if (key === ukey) {
                return value;
            }
        }
    }

    return '';
}

function upsetClassWithCss(cssText: string, ukey: string, uvalue: string) {
    const cssTextArray = cssText.split(';');
    let newCss = '';
    if (ukey == null || ukey.length === 0) {
        return cssText;
    }
    if (cssText.indexOf(ukey) > -1) {
        for (let i = 0; i < cssTextArray.length; i += 1) {
            let s = cssTextArray[i];
            s = s.toLowerCase();
            const key = s.substring(0, s.indexOf(':')).trim();
            const value = s.substring(s.indexOf(':') + 1).trim();
            if (key === ukey) {
                newCss += `${key}:${uvalue};`;
            } else if (key.length > 0) {
                newCss += `${key}:${value};`;
            }
        }
    } else if (ukey.length > 0) {
        cssText += `${ukey}:${uvalue};`;
        newCss = cssText;
    }

    return newCss;
}

function removeClassWidthCss(cssText: string, ukey: string) {
    const cssTextArray = cssText.split(';');
    let newCss = '';
    const oUkey = ukey;
    if (ukey == null || ukey.length === 0) {
        return cssText;
    }
    if (isStyleAttr(ukey)) {
        ukey = attrToCssName[ukey];
    }
    if (cssText.indexOf(ukey) > -1) {
        for (let i = 0; i < cssTextArray.length; i += 1) {
            let s = cssTextArray[i];
            s = s.toLowerCase();
            const key = s.substring(0, s.indexOf(':')).trim();
            const value = s.substring(s.indexOf(':') + 1).trim();
            if (
                key === ukey ||
                (oUkey === 'cl' && key === 'lucky-strike') ||
                (oUkey === 'un' && key === 'lucky-underline')
            ) {
            } else if (key.length > 0) {
                newCss += `${key}:${value};`;
            }
        }
    } else {
        newCss = cssText;
    }

    return newCss;
}

function getCssText(cssText: string, attr: keyof Cell, value: unknown) {
    const styleObj: Cell & UnderlineHints = {};
    (styleObj as Record<string, unknown>)[attr] = value;
    if (attr === 'un') {
        let fontColor = getClassWithcss(cssText, 'color');
        if (fontColor === '') {
            fontColor = '#000000';
        }
        let fs = getClassWithcss(cssText, 'font-size');
        if (fs === '') {
            fs = '11';
        }
        styleObj._fontSize = Number(fs);
        styleObj._color = fontColor;
    }
    const s = getFontStyleByCell(styleObj, undefined, false);
    const ukey = kebabCase(Object.keys(s)[0]);
    const uvalue = Object.values(s)[0] as string;
    // let cssText = span.style.cssText;
    cssText = removeClassWidthCss(cssText, attr);

    cssText = upsetClassWithCss(cssText, ukey, uvalue);

    return cssText;
}

function extendCssText(origin: string, cover: string, isLimit = true) {
    const originArray = origin.split(';');
    const coverArray = cover.split(';');
    let newCss = '';

    const addKeyList: Record<string, number> = {};
    for (let i = 0; i < originArray.length; i += 1) {
        let so = originArray[i];
        let isAdd = true;
        so = so.toLowerCase();
        const okey = so.substring(0, so.indexOf(':')).trim();

        /* Do not set font size here, to avoid the font growing larger after applying strikethrough etc. */
        if (okey === 'font-size') {
            continue;
        }

        const ovalue = so.substring(so.indexOf(':') + 1).trim();

        if (isLimit) {
            if (!(okey in inlineStyleAffectCssName)) {
                continue;
            }
        }

        for (let a = 0; a < coverArray.length; a += 1) {
            let sc = coverArray[a];
            sc = sc.toLowerCase();
            const ckey = sc.substring(0, sc.indexOf(':')).trim();
            const cvalue = sc.substring(sc.indexOf(':') + 1).trim();

            if (okey === ckey) {
                newCss += `${ckey}:${cvalue};`;
                isAdd = false;
            }
        }

        if (isAdd) {
            newCss += `${okey}:${ovalue};`;
        }

        addKeyList[okey] = 1;
    }

    for (let a = 0; a < coverArray.length; a += 1) {
        let sc = coverArray[a];
        sc = sc.toLowerCase();
        const ckey = sc.substring(0, sc.indexOf(':')).trim();
        const cvalue = sc.substring(sc.indexOf(':') + 1).trim();

        if (isLimit) {
            if (!(ckey in inlineStyleAffectCssName)) {
                continue;
            }
        }

        if (!(ckey in addKeyList)) {
            newCss += `${ckey}:${cvalue};`;
        }
    }

    return newCss;
}

export function updateInlineStringFormat(
    _ctx: Context,
    _cell: Cell,
    attr: keyof Cell,
    value: unknown,
    cellInput: HTMLDivElement,
) {
    // let s = ctx.inlineStringEditCache;
    const w = window.getSelection();
    if (!w) return;
    if (w.rangeCount === 0) return;

    const range = w.getRangeAt(0);

    const $textEditor = cellInput;

    if (range.collapsed === true) {
        return;
    }

    const { endContainer } = range;
    const { startContainer } = range;
    const { endOffset } = range;
    const { startOffset } = range;

    if ($textEditor) {
        if (startContainer === endContainer) {
            const span = startContainer.parentNode as HTMLElement | null;
            let spanIndex: number;
            let inherit = false;

            const content = span?.innerHTML || '';

            const fullContent = $textEditor.innerHTML;
            if (fullContent.substring(0, 5) !== '<span') {
                inherit = true;
            }

            if (span) {
                let left = '';
                let mid = '';
                let right = '';
                const s1 = 0;
                const s2 = startOffset;
                const s3 = endOffset;
                const s4 = content.length;
                left = content.substring(s1, s2);
                mid = content.substring(s2, s3);
                right = content.substring(s3, s4);

                let cont = '';
                if (left !== '') {
                    let { cssText } = span.style;
                    if (inherit) {
                        const box = span.closest('#sheet-input-box') as HTMLElement | null;
                        if (box != null) {
                            cssText = extendCssText(box.style.cssText, cssText);
                        }
                    }
                    cont += `<span style='${cssText}'>${left}</span>`;
                }

                if (mid !== '') {
                    let cssText = getCssText(span.style.cssText, attr, value);

                    if (inherit) {
                        const box = span.closest('#sheet-input-box') as HTMLElement | null;
                        if (box != null) {
                            cssText = extendCssText(box.style.cssText, cssText);
                        }
                    }

                    cont += `<span style='${cssText}'>${mid}</span>`;
                }

                if (right !== '') {
                    let { cssText } = span.style;
                    if (inherit) {
                        const box = span.closest('#sheet-input-box') as HTMLElement | null;
                        if (box != null) {
                            cssText = extendCssText(box.style.cssText, cssText);
                        }
                    }
                    cont += `<span style='${cssText}'>${right}</span>`;
                }

                if (startContainer.parentElement?.tagName === 'SPAN') {
                    spanIndex = indexOf($textEditor.querySelectorAll('span'), span);
                    span.outerHTML = cont;
                } else {
                    spanIndex = 0;
                    span.innerHTML = cont;
                }

                let seletedNodeIndex = 0;
                if (s1 === s2) {
                    seletedNodeIndex = spanIndex;
                } else {
                    seletedNodeIndex = spanIndex + 1;
                }

                selectTextContent($textEditor.querySelectorAll('span')[seletedNodeIndex]);
            }
        } else {
            if (startContainer.parentElement?.tagName === 'SPAN' && endContainer.parentElement?.tagName === 'SPAN') {
                const startSpan = startContainer.parentNode as HTMLElement | null;
                const endSpan = endContainer.parentNode as HTMLElement | null;
                const allSpans = $textEditor.querySelectorAll('span');

                const startSpanIndex = indexOf(allSpans, startSpan);
                const endSpanIndex = indexOf(allSpans, endSpan);

                const startContent = startSpan?.innerHTML || '';
                const endContent = endSpan?.innerHTML || '';
                let sleft = '';
                let sright = '';
                let eleft = '';
                let eright = '';
                const s1 = 0;
                const s2 = startOffset;
                const s3 = endOffset;
                const s4 = endContent.length;

                sleft = startContent.substring(s1, s2);
                sright = startContent.substring(s2, startContent.length);

                eleft = endContent.substring(0, s3);
                eright = endContent.substring(s3, s4);
                let spans = $textEditor.querySelectorAll('span');
                // const replaceSpans = spans.slice(startSpanIndex, endSpanIndex + 1);
                let cont = '';
                for (let i = 0; i < startSpanIndex; i += 1) {
                    const span = spans[i];
                    const content = span.innerHTML;
                    cont += `<span style='${span.style.cssText}'>${content}</span>`;
                }
                if (sleft !== '') {
                    cont += `<span style='${startSpan!.style.cssText}'>${sleft}</span>`;
                }

                if (sright !== '') {
                    const cssText = getCssText(startSpan!.style.cssText, attr, value);
                    cont += `<span style='${cssText}'>${sright}</span>`;
                }

                if (startSpanIndex < endSpanIndex) {
                    for (let i = startSpanIndex + 1; i < endSpanIndex; i += 1) {
                        const span = spans[i];
                        const content = span.innerHTML;
                        cont += `<span style='${span.style.cssText}'>${content}</span>`;
                    }
                }

                if (eleft !== '') {
                    const cssText = getCssText(endSpan!.style.cssText, attr, value);
                    cont += `<span style='${cssText}'>${eleft}</span>`;
                }

                if (eright !== '') {
                    cont += `<span style='${endSpan!.style.cssText}'>${eright}</span>`;
                }

                for (let i = endSpanIndex + 1; i < spans.length; i += 1) {
                    const span = spans[i];
                    const content = span.innerHTML;
                    cont += `<span style='${span.style.cssText}'>${content}</span>`;
                }

                $textEditor.innerHTML = cont;

                let startSeletedNodeIndex: number;
                let endSeletedNodeIndex: number;
                if (s1 === s2) {
                    startSeletedNodeIndex = startSpanIndex;
                    endSeletedNodeIndex = endSpanIndex;
                } else {
                    startSeletedNodeIndex = startSpanIndex + 1;
                    endSeletedNodeIndex = endSpanIndex + 1;
                }

                spans = $textEditor.querySelectorAll('span');

                selectTextContentCross(spans[startSeletedNodeIndex], spans[endSeletedNodeIndex]);
            }
        }
    }
}
