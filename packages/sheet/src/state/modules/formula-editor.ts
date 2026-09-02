import { escapeHtml, unescapeHtml } from '@workspace/lib/html';
import { indexOf, isEmpty, isNil, last, startsWith, trim } from 'es-toolkit/compat';
import { iscelldata, operatorjson } from '../../engine/formula-utils';
import type { Context } from '../context';

import { cancelFunctionrangeSelected } from '.';
import { colors } from './color';
import {
    formulaUIState,
    resetFunctionHTMLIndex,
    resetRangeIndexes,
    setFunctionHTMLIndex,
    setRangeIndexes,
} from './formula-cache';
import { createRangeHightlight, setCaretPosition } from './formula-range';
import { type FormulaFunctionEntry, FUNCTION_LIST } from './function-list';

function functionHTML(txt: string) {
    if (txt[0] === '=') {
        txt = txt.slice(1);
    }

    const funcstack = txt.split('');
    let i = 0;
    let str = '';
    let function_str = '';
    const matchConfig = {
        bracket: 0,
        comma: 0,
        squote: 0,
        dquote: 0,
        braces: 0,
    };

    while (i < funcstack.length) {
        const s = funcstack[i];

        if (s === '(' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            matchConfig.bracket += 1;

            if (str.length > 0) {
                function_str += `<span dir="auto" class="sheet-formula-text-func">${escapeHtml(str)}</span><span dir="auto" class="sheet-formula-text-lpar">(</span>`;
            } else {
                function_str += '<span dir="auto" class="sheet-formula-text-lpar">(</span>';
            }

            str = '';
        } else if (s === ')' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            matchConfig.bracket -= 1;
            function_str += `${functionHTML(str)}<span dir="auto" class="sheet-formula-text-rpar">)</span>`;
            str = '';
        } else if (s === '{' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '{';
            matchConfig.braces += 1;
        } else if (s === '}' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '}';
            matchConfig.braces -= 1;
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                if (str.length > 0) {
                    function_str += `${escapeHtml(str)}"</span>`;
                } else {
                    function_str += '"</span>';
                }

                matchConfig.dquote -= 1;
                str = '';
            } else {
                matchConfig.dquote += 1;

                if (str.length > 0) {
                    function_str += `${functionHTML(str)}<span dir="auto" class="sheet-formula-text-string">"`;
                } else {
                    function_str += '<span dir="auto" class="sheet-formula-text-string">"';
                }

                str = '';
            }
        }
        // Fix the issue where entering a formula like ='1-2'!A1 causes only 2'!A1 to be colored as sheet-formula-functionrange-cell, while '1- remains black.
        else if (s === "'" && matchConfig.dquote === 0) {
            str += "'";
            matchConfig.squote = matchConfig.squote === 0 ? 1 : 0;
        } else if (s === ',' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            // matchConfig.comma += 1;
            function_str += `${functionHTML(str)}<span dir="auto" class="sheet-formula-text-comma">,</span>`;
            str = '';
        } else if (s === '&' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            if (str.length > 0) {
                function_str += `${functionHTML(str)}<span dir="auto" class="sheet-formula-text-calc">&amp;</span>`;
                str = '';
            } else {
                function_str += '<span dir="auto" class="sheet-formula-text-calc">&amp;</span>';
            }
        } else if (
            s in operatorjson &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            let s_next = '';
            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            let p = i - 1;
            let s_pre = null;
            if (p >= 0) {
                do {
                    s_pre = funcstack[p];
                    p -= 1;
                } while (p >= 0 && s_pre === ' ');
            }

            if (s + s_next in operatorjson) {
                if (str.length > 0) {
                    function_str += `${functionHTML(
                        str,
                    )}<span dir="auto" class="sheet-formula-text-calc">${escapeHtml(s + s_next)}</span>`;
                    str = '';
                } else {
                    function_str += `<span dir="auto" class="sheet-formula-text-calc">${escapeHtml(s + s_next)}</span>`;
                }

                i += 1;
            } else if (
                !/[^0-9]/.test(s_next) &&
                s === '-' &&
                (s_pre === '(' || isNil(s_pre) || s_pre === ',' || s_pre === ' ' || s_pre in operatorjson)
            ) {
                str += s;
            } else {
                if (str.length > 0) {
                    function_str += `${functionHTML(
                        str,
                    )}<span dir="auto" class="sheet-formula-text-calc">${escapeHtml(s)}</span>`;
                    str = '';
                } else {
                    function_str += `<span dir="auto" class="sheet-formula-text-calc">${escapeHtml(s)}</span>`;
                }
            }
        } else {
            str += s;
        }

        if (i === funcstack.length - 1) {
            // function_str += str;
            if (iscelldata(trim(str))) {
                const rangeIndex =
                    formulaUIState.rangeIndexes.length > formulaUIState.functionHTMLIndex
                        ? formulaUIState.rangeIndexes[formulaUIState.functionHTMLIndex]
                        : formulaUIState.functionHTMLIndex;
                function_str += `<span class="sheet-formula-functionrange-cell" rangeindex="${rangeIndex}" dir="auto" style="color:${colors[rangeIndex]};">${escapeHtml(str)}</span>`;
                setFunctionHTMLIndex(formulaUIState.functionHTMLIndex + 1);
            } else if (matchConfig.dquote > 0) {
                function_str += `${escapeHtml(str)}</span>`;
            } else if (str.indexOf('</span>') === -1 && str.length > 0) {
                const regx = /{.*?}/;

                if (regx.test(trim(str))) {
                    const arraytxt = regx.exec(str)![0];
                    const arraystart = str.search(regx);
                    let alltxt = '';

                    if (arraystart > 0) {
                        alltxt += `<span dir="auto" class="sheet-formula-text-color">${escapeHtml(str.slice(0, arraystart))}</span>`;
                    }

                    alltxt += `<span dir="auto" style="color:#959a05" class="sheet-formula-text-array">${escapeHtml(arraytxt)}</span>`;

                    if (arraystart + arraytxt.length < str.length) {
                        alltxt += `<span dir="auto" class="sheet-formula-text-color">${escapeHtml(str.slice(arraystart + arraytxt.length))}</span>`;
                    }

                    function_str += alltxt;
                } else {
                    function_str += `<span dir="auto" class="sheet-formula-text-color">${escapeHtml(str)}</span>`;
                }
            }
        }

        i += 1;
    }

    return function_str;
}

export function functionHTMLGenerate(txt: string) {
    if (txt.length === 0 || txt.substring(0, 1) !== '=') {
        return txt;
    }

    resetFunctionHTMLIndex();

    return `<span dir="auto" class="sheet-formula-text-color">=</span>${functionHTML(txt)}`;
}

function getRangeIndexes($editor: HTMLDivElement) {
    const res: number[] = [];
    for (const ele of $editor.querySelectorAll('span.sheet-formula-functionrange-cell')) {
        const indexStr = ele.getAttribute('rangeindex');
        if (indexStr) {
            const rangeIndex = parseInt(indexStr, 10);
            res.push(rangeIndex);
        }
    }
    return res;
}

function searchFunction(ctx: Context, searchtxt: string) {
    // // This logic has been modified from the original project
    // if (isNil($editer)) {
    //   return;
    // }
    // const inputContent = $editer.innerText.toUpperCase();
    // const reg = /^=([a-zA-Z_]+)\(?/;
    // const match = inputContent.match(reg);
    // if (!match) {
    //   ctx.functionCandidates = [];
    //   return;
    // }

    // const searchtxt = match[1];

    const f: FormulaFunctionEntry[] = [];
    const s: FormulaFunctionEntry[] = [];
    const t: FormulaFunctionEntry[] = [];
    let result_i = 0;

    for (let i = 0; i < FUNCTION_LIST.length; i += 1) {
        const item = FUNCTION_LIST[i];
        const { n } = item;

        if (n === searchtxt) {
            f.unshift(item);
            result_i += 1;
        } else if (startsWith(n, searchtxt)) {
            s.unshift(item);
            result_i += 1;
        } else if (n.indexOf(searchtxt) > -1) {
            t.unshift(item);
            result_i += 1;
        }

        if (result_i >= 10) {
            break;
        }
    }

    const list = [...f, ...s, ...t];
    if (list.length <= 0) {
        return;
    }

    ctx.functionCandidates = list;
}

export function insertFormulaFunctionDom(target: HTMLElement, formulaName: string): boolean {
    const searchTxt = getrangeseleciton()?.textContent || '';
    const deleteCount = searchTxt.length;
    target.focus();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    if (deleteCount !== 0) {
        const startOffset = Math.max(range.startOffset - deleteCount, 0);
        const endOffset = range.startOffset;
        range.setStart(range.startContainer, startOffset);
        range.setEnd(range.startContainer, endOffset);
        range.deleteContents();
    }

    const functionStr = `<span dir="auto" class="sheet-formula-text-func">${formulaName}</span>`;
    const lParStr = `<span dir="auto" class="sheet-formula-text-lpar">(</span>`;
    const functionNode = new DOMParser().parseFromString(functionStr, 'text/html').body.childNodes[0];
    const lParNode = new DOMParser().parseFromString(lParStr, 'text/html').body.childNodes[0];

    if (range.startContainer.parentNode) {
        range.setStart(range.startContainer.parentNode, 1);
    }
    range.insertNode(lParNode);
    range.insertNode(functionNode);
    range.collapse();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

export function getrangeseleciton() {
    const currSelection = window.getSelection();
    if (!currSelection) return null;
    const { anchorNode, anchorOffset } = currSelection;

    if (!anchorNode) return null;

    if (anchorNode.parentNode?.nodeName?.toLowerCase() === 'span' && anchorOffset !== 0) {
        let txt = trim(anchorNode.textContent || '');
        if (txt.length === 0 && anchorNode.parentNode.previousSibling) {
            const ahr = anchorNode.parentNode.previousSibling;
            txt = trim(ahr.textContent || '');
            return ahr;
        }
        return anchorNode.parentNode;
    }
    const anchorElement = anchorNode as HTMLElement;
    if (anchorElement.id === 'sheet-rich-text-editor' || anchorElement.id === 'sheet-functionbox-cell') {
        let txt = trim(last(anchorElement.querySelectorAll('span'))?.innerText);

        if (txt.length === 0 && anchorElement.querySelectorAll('span').length > 1) {
            const ahr = anchorElement.querySelectorAll('span');
            txt = trim(ahr[ahr.length - 2].innerText);
            return ahr?.[0];
        }
        return last(anchorElement.querySelectorAll('span'));
    }
    if (
        anchorNode?.parentElement?.id === 'sheet-rich-text-editor' ||
        anchorNode?.parentElement?.id === 'sheet-functionbox-cell' ||
        anchorOffset === 0
    ) {
        const newAnchorNode = anchorOffset === 0 ? anchorNode?.parentNode : anchorNode;

        if (newAnchorNode?.previousSibling) {
            return newAnchorNode?.previousSibling;
        }
    }

    return null;
}

function helpFunctionExe($editer: HTMLDivElement, currSelection: Node, ctx: Context) {
    if (isEmpty(ctx.formulaCache.functionlistMap)) {
        for (const fn of FUNCTION_LIST) {
            ctx.formulaCache.functionlistMap[fn.n] = fn;
        }
    }

    const $span = $editer.querySelectorAll('span');
    const currentIndex = indexOf(currSelection.parentNode?.childNodes, currSelection);
    if (currentIndex < 0 || !$span[currentIndex]) return null;

    if ($span[currentIndex].classList.contains('sheet-formula-text-func')) {
        return $span[currentIndex].textContent;
    }

    let exceptIndex: [number, number] = [-1, -1];
    for (let i = currentIndex - 1; i > 0; i -= 1) {
        const $cur = $span[i];
        if (
            !$cur.classList.contains('sheet-formula-text-func') &&
            !(trim($cur.textContent || '').toUpperCase() in ctx.formulaCache.functionlistMap)
        ) {
            continue;
        }

        // The function header at $span[i] may not actually bracket the caret —
        // if any rpar appears between i and currentIndex, this is a closed call,
        // not the enclosing one. Skip it (recording the bracket span in
        // exceptIndex so nested closed calls aren't reconsidered).
        let closedAt = -1;
        for (let a = i; a <= currentIndex; a += 1) {
            if (a >= exceptIndex[0] && a <= exceptIndex[1]) continue;
            if ($span[a].classList.contains('sheet-formula-text-rpar')) {
                closedAt = a;
                break;
            }
        }
        if (closedAt === -1) return $cur.textContent;
        exceptIndex = [i, closedAt];
    }

    return null;
}

export function rangeHightlightselected(ctx: Context, $editor: HTMLDivElement) {
    const currSelection = getrangeseleciton();
    if (!currSelection) return;

    const currText = trim(currSelection.textContent || '');
    if (currText?.match(/^[a-zA-Z_]+$/)) {
        searchFunction(ctx, currText.toUpperCase());
        ctx.functionHint = null;
    } else {
        const funcName = helpFunctionExe($editor, currSelection, ctx);
        ctx.functionHint = funcName?.toUpperCase();
        ctx.functionCandidates = [];
    }
}

export function israngeseleciton(ctx: Context, istooltip?: boolean) {
    if (istooltip == null) {
        istooltip = false;
    }

    const currSelection = window.getSelection();
    if (currSelection == null) return false;
    let anchor = currSelection.anchorNode;
    if (!anchor?.textContent) return false;
    const { anchorOffset } = currSelection;
    const anchorElement = anchor as HTMLElement;
    const parentElement = anchor.parentNode as HTMLElement;
    if (anchor?.parentNode?.nodeName.toLowerCase() === 'span' && anchorOffset !== 0) {
        let txt = trim(anchor.textContent);
        let lasttxt = '';

        if (txt.length === 0 && anchor.parentNode.previousSibling) {
            const ahr = anchor.parentNode.previousSibling;
            txt = trim(ahr.textContent || '');
            lasttxt = txt.substring(txt.length - 1, 1);
            ctx.formulaCache.rangeSetValueTo = anchor.parentNode;
        } else {
            lasttxt = txt.substring(anchorOffset - 1, 1);
            ctx.formulaCache.rangeSetValueTo = anchor.parentNode;
        }

        if (
            (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
            (!istooltip &&
                (lasttxt === '(' || lasttxt === ',' || lasttxt === '=' || lasttxt in operatorjson || lasttxt === '&'))
        ) {
            return true;
        }
    } else if (anchorElement.id === 'sheet-rich-text-editor' || anchorElement.id === 'sheet-functionbox-cell') {
        let txt = trim(last(anchorElement.querySelectorAll('span'))?.innerText);

        ctx.formulaCache.rangeSetValueTo = last(anchorElement.querySelectorAll('span'));

        if (txt.length === 0 && anchorElement.querySelectorAll('span').length > 1) {
            const ahr = anchorElement.querySelectorAll('span');
            const prev = ahr[ahr.length - 2];
            txt = trim(prev.innerText);
            ctx.formulaCache.rangeSetValueTo = prev;
        }

        const lasttxt = txt.substring(txt.length - 1, 1);

        if (
            (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
            (!istooltip &&
                (lasttxt === '(' || lasttxt === ',' || lasttxt === '=' || lasttxt in operatorjson || lasttxt === '&'))
        ) {
            return true;
        }
    } else if (
        parentElement.id === 'sheet-rich-text-editor' ||
        parentElement.id === 'sheet-functionbox-cell' ||
        anchorOffset === 0
    ) {
        if (anchorOffset === 0) {
            anchor = anchor.parentNode;
        }
        if (!anchor) return false;
        if (anchor.previousSibling?.textContent == null) return false;
        if (anchor.previousSibling) {
            const txt = trim(anchor.previousSibling.textContent);
            const lasttxt = txt.substring(txt.length - 1, 1);

            ctx.formulaCache.rangeSetValueTo = anchor.previousSibling;

            if (
                (istooltip && (lasttxt === '(' || lasttxt === ',')) ||
                (!istooltip &&
                    (lasttxt === '(' ||
                        lasttxt === ',' ||
                        lasttxt === '=' ||
                        lasttxt in operatorjson ||
                        lasttxt === '&'))
            ) {
                return true;
            }
        }
    }

    return false;
}

function functionRange(ctx: Context, obj: HTMLDivElement, v: string, vp: string) {
    const currSelection = window.getSelection();
    if (!currSelection) return;
    const fri = findrangeindex(ctx, v, vp);

    if (isNil(fri)) {
        currSelection.selectAllChildren(obj);
        currSelection.collapseToEnd();
    } else {
        setCaretPosition(ctx, obj.querySelectorAll('span')[fri[0]], 0, fri[1]);
    }
}

// Caret restore reads these segments as the text the browser renders: their lengths become
// text-node offsets, and they are probed for quotes and braces. Tokens are escaped on the way
// into the markup, so `&` is five characters here and one on screen — decode before measuring.
function toRenderedSegments(html: string): string[] {
    return html
        .replace(/<span.*?>/g, '')
        .split('</span>')
        .map(unescapeHtml);
}

function findrangeindex(ctx: Context, v: string, vp: string) {
    const v_a = toRenderedSegments(v);
    const vp_a = toRenderedSegments(vp);
    v_a.pop();
    if (vp_a[vp_a.length - 1] === '') vp_a.pop();

    let pfri = ctx.formulaCache.functionRangeIndex;
    if (pfri == null) return [];

    const vplen = vp_a.length;
    const vlen = v_a.length;
    // No element added to input
    if (vplen === vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (isNil(p)) {
            if (vp_a.length <= i) {
                pfri = [vp_a.length - 1, vp_a.length - 1];
            } else if (v_a.length <= i) {
                pfri = [v_a.length - 1, v_a.length - 1];
            }

            return pfri;
        }
        if (p.length === n.length) {
            if (!isNil(vp_a[i + 1]) && !isNil(v_a[i + 1]) && vp_a[i + 1].length < v_a[i + 1].length) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        }
        if (p.length > n.length) {
            if (
                !isNil(p) &&
                !isNil(v_a[i + 1]) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (p.indexOf('{') > -1 || p.indexOf('}') > -1)
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        }
        if (p.length < n.length) {
            if (pfri[1] > n.length) {
                pfri[1] = n.length;
            }

            return pfri;
        }
    }
    // Element removed from input
    else if (vplen > vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (isNil(n)) {
            if (v_a[i - 1].indexOf('{') > -1) {
                pfri[0] -= 1;
                const start = v_a[i - 1].search('{');
                pfri[1] += start;
            } else {
                pfri[0] = 0;
                pfri[1] = 0;
            }
        } else if (p.length === n.length) {
            if (
                !isNil(v_a[i + 1]) &&
                (v_a[i + 1].substring(0, 1) === '"' ||
                    v_a[i + 1].substring(0, 1) === '{' ||
                    v_a[i + 1].substring(0, 1) === '}')
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (!isNil(p) && p.length > 2 && p.substring(0, 1) === '"' && p.substring(p.length - 1, 1) === '"') {
                // pfri[1] = n.length-1;
            } else if (!isNil(v_a[i]) && v_a[i] === '")') {
                pfri[1] = 1;
            } else if (!isNil(v_a[i]) && v_a[i] === '"}') {
                pfri[1] = 1;
            } else if (!isNil(v_a[i]) && v_a[i] === '{)') {
                pfri[1] = 1;
            } else {
                pfri[1] = n.length;
            }

            return pfri;
        } else if (p.length > n.length) {
            if (
                !isNil(v_a[i + 1]) &&
                (v_a[i + 1].substring(0, 1) === '"' ||
                    v_a[i + 1].substring(0, 1) === '{' ||
                    v_a[i + 1].substring(0, 1) === '}')
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            }

            return pfri;
        } else if (p.length < n.length) {
            return pfri;
        }

        return pfri;
    }
    // Element added to input
    else if (vplen < vlen) {
        const i = pfri[0];
        const p = vp_a[i];
        const n = v_a[i];

        if (isNil(p)) {
            pfri[0] = v_a.length - 1;

            if (!isNil(n)) {
                pfri[1] = n.length;
            } else {
                pfri[1] = 1;
            }
        } else if (p.length === n.length) {
            if (
                vp_a[i + 1] != null &&
                (vp_a[i + 1].substring(0, 1) === '"' ||
                    vp_a[i + 1].substring(0, 1) === '{' ||
                    vp_a[i + 1].substring(0, 1) === '}')
            ) {
                pfri[1] = n.length;
            } else if (
                !isNil(v_a[i + 1]) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (v_a[i + 1].substring(0, 1) === '{' || v_a[i + 1].substring(0, 1) === '}')
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (
                !isNil(n) &&
                n.substring(0, 1) === '"' &&
                n.substring(n.length - 1, 1) === '"' &&
                p.substring(0, 1) === '"' &&
                p.substring(p.length - 1, 1) === ')'
            ) {
                pfri[1] = n.length;
            } else if (
                !isNil(n) &&
                n.substring(0, 1) === '{' &&
                n.substring(n.length - 1, 1) === '}' &&
                p.substring(0, 1) === '{' &&
                p.substring(p.length - 1, 1) === ')'
            ) {
                pfri[1] = n.length;
            } else {
                pfri[0] = pfri[0] + vlen - vplen;
                if (v_a.length > vp_a.length) {
                    pfri[1] = v_a[i + 1].length;
                } else {
                    pfri[1] = 1;
                }
            }

            return pfri;
        } else if (p.length > n.length) {
            if (!isNil(p) && p.substring(0, 1) === '"') {
                pfri[1] = n.length;
            } else if (isNil(v_a[i + 1]) && /{.*?}/.test(v_a[i + 1])) {
                pfri[0] += 1;
                pfri[1] = v_a[i + 1].length;
            } else if (
                !isNil(p) &&
                v_a[i + 1].substring(0, 1) === '"' &&
                (p.indexOf('{') > -1 || p.indexOf('}') > -1)
            ) {
                pfri[0] += 1;
                pfri[1] = 1;
            } else if (!isNil(p) && (p.indexOf('{') > -1 || p.indexOf('}') > -1)) {
            } else if (!isNil(p) && !startsWith(p[0], '=') && startsWith(n, '=')) {
                return [vlen - 1, v_a[vlen - 1].length];
            } else {
                pfri[0] = pfri[0] + vlen - vplen - 1;
                pfri[1] = v_a[(i || 1) - 1].length;
            }

            return pfri;
        } else if (p.length < n.length) {
            return pfri;
        }

        return pfri;
    }

    return null;
}

export function handleFormulaInput(
    ctx: Context,
    $copyTo: HTMLDivElement | null | undefined,
    $editor: HTMLDivElement,
    kcode: number,
    preText?: string,
    refreshRangeSelect = true,
) {
    let value1: string;
    const value1txt = preText ?? $editor.innerText;
    let value = $editor.innerText;
    if (value.length > 0 && value.substring(0, 1) === '=' && (kcode !== 229 || value.length === 1)) {
        if (!refreshRangeSelect) setRangeIndexes(getRangeIndexes($editor));
        value = functionHTMLGenerate(value);
        if (!refreshRangeSelect && formulaUIState.functionHTMLIndex < formulaUIState.rangeIndexes.length)
            refreshRangeSelect = true;
        value1 = functionHTMLGenerate(value1txt);

        resetRangeIndexes();

        const currSelection = window.getSelection();
        if (!currSelection) return;
        if (currSelection.anchorNode?.nodeName.toLowerCase() === 'div') {
            const editorlen = $editor.querySelectorAll('span').length;
            if (editorlen > 0)
                ctx.formulaCache.functionRangeIndex = [
                    editorlen - 1,
                    $editor.querySelectorAll('span').item(editorlen - 1).textContent?.length ?? 0,
                ];
        } else {
            const childNodes = currSelection.anchorNode?.parentNode?.parentNode?.childNodes;
            const parentNode = currSelection.anchorNode?.parentNode;
            ctx.formulaCache.functionRangeIndex = [
                childNodes && parentNode ? Array.prototype.indexOf.call(childNodes, parentNode) : -1,
                currSelection.anchorOffset,
            ];
        }

        $editor.innerHTML = value;
        if ($copyTo) $copyTo.innerHTML = value;

        // the cursor will be set to the beginning of input box after set innerHTML,
        // restoring it to the correct position
        functionRange(ctx, $editor, value, value1);

        if (refreshRangeSelect) {
            cancelFunctionrangeSelected(ctx);

            if (kcode !== 46) {
                // Do not execute this function on delete
                createRangeHightlight(ctx, value);
            }

            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_column_start = false;
            ctx.formulaCache.rangedrag_row_start = false;

            rangeHightlightselected(ctx, $editor);
        }
    } else if (startsWith(value1txt, '=') && !startsWith(value, '=')) {
        if ($copyTo) $copyTo.innerHTML = escapeHtml(value);
        $editor.innerHTML = escapeHtml(value);
    } else if (!startsWith(value1txt, '=')) {
        if (!$copyTo) return;
        if ($copyTo.id === 'sheet-rich-text-editor') {
            if (!startsWith($copyTo.innerHTML, '<span')) {
                $copyTo.innerHTML = escapeHtml(value);
            }
        } else {
            $copyTo.innerHTML = escapeHtml(value);
        }
    }
}
