// Editing a formula as text: functionHTMLGenerate colors its references, numbers and strings as spans, and
// handleFormulaInput rebuilds them on each keystroke in the cell editor or the formula bar, puts the caret back and
// updates the reference highlights on the grid. The helpers here also read the token at the caret, for the function
// suggestions and the hint of the function the caret is in.

import { escapeHtml } from '@workspace/lib/html';
import { indexOf, isEmpty, isNil, last, startsWith, trim } from 'es-toolkit/compat';
import { formulaOperators, iscelldata } from '../../engine/formula-utils';
import type { Context } from '../context';

import { cancelFunctionrangeSelected } from '.';
import { rangeColor } from './color';
import { selectionTextOffsets, selectTextOffsets } from './cursor';
import {
    formulaUIState,
    resetFunctionHTMLIndex,
    resetRangeIndexes,
    setFunctionHTMLIndex,
    setRangeIndexes,
} from './formula-cache';
import { createRangeHighlight } from './formula-range';
import type { FormulaFunctionEntry } from './function-list';
import { FUNCTION_LIST } from './function-list';

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
            formulaOperators.has(s) &&
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

            if (formulaOperators.has(s + s_next)) {
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
                (s_pre === '(' || isNil(s_pre) || s_pre === ',' || s_pre === ' ' || formulaOperators.has(s_pre))
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
            if (iscelldata(trim(str))) {
                const rangeIndex =
                    formulaUIState.rangeIndexes.length > formulaUIState.functionHTMLIndex
                        ? formulaUIState.rangeIndexes[formulaUIState.functionHTMLIndex]
                        : formulaUIState.functionHTMLIndex;
                function_str += `<span class="sheet-formula-functionrange-cell" rangeindex="${rangeIndex}" dir="auto" style="color:${rangeColor(rangeIndex)};">${escapeHtml(str)}</span>`;
                setFunctionHTMLIndex(formulaUIState.functionHTMLIndex + 1);
            } else if (matchConfig.dquote > 0) {
                function_str += `${escapeHtml(str)}</span>`;
            } else if (str.indexOf('</span>') === -1 && str.length > 0) {
                const arrayMatch = /{.*?}/.exec(str);

                if (arrayMatch) {
                    const [arraytxt] = arrayMatch;
                    const arraystart = arrayMatch.index;
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
        if (indexStr) res.push(parseInt(indexStr, 10));
    }
    return res;
}

function searchFunction(ctx: Context, searchtxt: string) {
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
    const searchTxt = tokenAtCaret()?.textContent || '';
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

function tokenAtCaret() {
    const currSelection = window.getSelection();
    if (!currSelection) return null;
    const { anchorNode, anchorOffset } = currSelection;

    if (!anchorNode) return null;

    if (anchorNode.parentNode?.nodeName?.toLowerCase() === 'span' && anchorOffset !== 0) {
        if (trim(anchorNode.textContent || '').length === 0 && anchorNode.parentNode.previousSibling) {
            return anchorNode.parentNode.previousSibling;
        }
        return anchorNode.parentNode;
    }
    if (
        anchorNode instanceof HTMLElement &&
        (anchorNode.id === 'sheet-rich-text-editor' || anchorNode.id === 'sheet-functionbox-cell')
    ) {
        const spans = anchorNode.querySelectorAll('span');
        if (trim(last(spans)?.innerText).length === 0 && spans.length > 1) {
            return spans[0];
        }
        return last(spans);
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

function enclosingFunctionName($editor: HTMLDivElement, currSelection: Node, ctx: Context) {
    if (isEmpty(ctx.formulaCache.functionlistMap)) {
        for (const fn of FUNCTION_LIST) {
            ctx.formulaCache.functionlistMap[fn.n] = fn;
        }
    }

    const $span = $editor.querySelectorAll('span');
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

export function updateFunctionHint(ctx: Context, $editor: HTMLDivElement) {
    const currSelection = tokenAtCaret();
    if (!currSelection) return;

    const currText = trim(currSelection.textContent || '');
    if (currText?.match(/^[a-zA-Z_]+$/)) {
        searchFunction(ctx, currText.toUpperCase());
        ctx.functionHint = null;
    } else {
        const funcName = enclosingFunctionName($editor, currSelection, ctx);
        ctx.functionHint = funcName?.toUpperCase();
        ctx.functionCandidates = [];
    }
}

// Whether the caret sits where a picked range goes, after an opening bracket, a comma or an operator. It also notes
// the span the range goes after.
export function caretTakesRange(ctx: Context) {
    const currSelection = window.getSelection();
    if (currSelection == null) return false;
    let anchor = currSelection.anchorNode;
    if (!anchor?.textContent) return false;
    const { anchorOffset } = currSelection;
    if (anchor.parentNode?.nodeName.toLowerCase() === 'span' && anchorOffset !== 0) {
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

        return opensRange(lasttxt);
    } else if (
        anchor instanceof HTMLElement &&
        (anchor.id === 'sheet-rich-text-editor' || anchor.id === 'sheet-functionbox-cell')
    ) {
        const spans = anchor.querySelectorAll('span');
        let txt = trim(last(spans)?.innerText);

        ctx.formulaCache.rangeSetValueTo = last(spans);

        if (txt.length === 0 && spans.length > 1) {
            const prev = spans[spans.length - 2];
            txt = trim(prev.innerText);
            ctx.formulaCache.rangeSetValueTo = prev;
        }

        return opensRange(txt.substring(txt.length - 1, 1));
    } else if (
        anchor.parentElement?.id === 'sheet-rich-text-editor' ||
        anchor.parentElement?.id === 'sheet-functionbox-cell' ||
        anchorOffset === 0
    ) {
        if (anchorOffset === 0) {
            anchor = anchor.parentNode;
        }
        const previous = anchor?.previousSibling;
        if (previous?.textContent == null) return false;
        const txt = trim(previous.textContent);
        ctx.formulaCache.rangeSetValueTo = previous;
        return opensRange(txt.substring(txt.length - 1, 1));
    }

    return false;
}

function opensRange(text: string) {
    return text === '(' || text === ',' || text === '=' || text === '&' || formulaOperators.has(text);
}

// What a formula opens with in the editor: `=NAME(`, each part in the color of plain formula text.
export function functionCallHtml(name: string) {
    return `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${name}</span><span dir="auto" class="sheet-formula-text-color">(</span>`;
}

export function handleFormulaInput(
    ctx: Context,
    $copyTo: HTMLDivElement | null | undefined,
    $editor: HTMLDivElement,
    kcode: number,
    preText?: string,
    refreshRangeSelect = true,
) {
    const value1txt = preText ?? $editor.innerText;
    let value = $editor.innerText;
    if (value.length > 0 && value.substring(0, 1) === '=' && (kcode !== 229 || value.length === 1)) {
        if (!refreshRangeSelect) setRangeIndexes(getRangeIndexes($editor));
        value = functionHTMLGenerate(value);
        if (!refreshRangeSelect && formulaUIState.functionHTMLIndex < formulaUIState.rangeIndexes.length)
            refreshRangeSelect = true;
        // Counting the text before the key sets functionHTMLIndex, the index the next picked reference takes.
        functionHTMLGenerate(value1txt);

        resetRangeIndexes();

        const caret = selectionTextOffsets($editor)?.end ?? value1txt.length;
        $editor.innerHTML = value;
        if ($copyTo) $copyTo.innerHTML = value;
        selectTextOffsets($editor, caret, caret);

        if (refreshRangeSelect) {
            cancelFunctionrangeSelected(ctx);

            if (kcode !== 46) {
                // Do not execute this function on delete
                createRangeHighlight(ctx, value);
            }

            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_column_start = false;
            ctx.formulaCache.rangedrag_row_start = false;

            updateFunctionHint(ctx, $editor);
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
