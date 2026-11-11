// What one cell of a pasted HTML table holds: its value and its look, read from the element and the table's <style>
// block as a program such as Excel writes them. A paste of a table reads each cell through these and places them.

import { bundledFontOfStack, readCssFontSize } from '@workspace/lib/constants/fonts';
import { SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { includes, isEmpty } from 'es-toolkit/compat';
import { parseCellInput } from '../../engine/format';
import type { Cell } from '../../engine/types';
import { HORIZONTAL_ALIGNS, VERTICAL_ALIGNS } from '../modules/toolbar';

// Reads a pasted <style> block into each rule's declarations, keyed by selector. Office writes properties a browser's
// own CSS parser drops, such as mso-rotate, so the paste reads the text itself.
export function readStyleRules(css: string): Map<string, Record<string, string>> {
    const rules = new Map<string, Record<string, string>>();
    const text = css
        .replace(/<!--|-->|\/\*[\s\S]*?\*\//g, ' ')
        .replace(/@[^{};]*(?:;|\{(?:[^{}]|\{[^{}]*\})*\})/g, ' ');
    for (const [, selectors, body] of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const declarations: Record<string, string> = {};
        for (const [declaration] of body.matchAll(/(?:[^;"']|"[^"]*"|'[^']*')+/g)) {
            const colon = declaration.indexOf(':');
            if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
        }
        for (const selector of selectors.split(',')) {
            const key = selector.trim().replace(/^td(?=\.)/, '');
            rules.set(key, { ...rules.get(key), ...declarations });
        }
    }
    return rules;
}

// One <td> as a cell, its look from its inline style first and its class's rule after.
export function pastedCell(
    td: HTMLTableCellElement,
    styles: Record<string, string>,
    tableVerticalAlign: string | undefined,
): Cell {
    const cell: Cell = {};
    const text = td.innerText || td.innerHTML;
    if (!text.trim()) {
        cell.v = undefined;
        cell.m = '';
    } else {
        [cell.m, cell.ct, cell.v] = parseCellInput(text);
    }
    let bg: string | undefined = td.style.backgroundColor || styles.background;
    if (bg === 'rgba(0, 0, 0, 0)' || isEmpty(bg)) bg = undefined;
    cell.bg = bg;

    const fontWeight = td.style.fontWeight;
    cell.bl =
        (fontWeight === '400' || fontWeight === 'normal' || isEmpty(fontWeight)) &&
        !includes(styles['font-style'], 'bold') &&
        (!styles['font-weight'] || styles['font-weight'] === '400')
            ? 0
            : 1;

    cell.it =
        (td.style.fontStyle === 'normal' || isEmpty(td.style.fontStyle)) && !includes(styles['font-style'], 'italic')
            ? 0
            : 1;

    cell.un =
        includes(td.style.textDecoration, 'underline') || includes(styles['text-decoration'], 'underline')
            ? 1
            : undefined;

    cell.cl =
        includes(td.innerHTML, '<s>') ||
        includes(td.style.textDecoration, 'line-through') ||
        includes(styles['text-decoration'], 'line-through')
            ? 1
            : undefined;

    const ff = bundledFontOfStack(td.style.fontFamily || styles['font-family'] || '');
    if (ff) cell.ff = ff;
    cell.fs =
        readCssFontSize(td.style.fontSize) ?? readCssFontSize(styles['font-size'] ?? '') ?? SHEET_DEFAULT_FONT_SIZE;

    cell.fc = td.style.color || styles.color;

    // A cell without one is left to its value, so a number lands on the right.
    const textAlign = td.style.textAlign || styles['text-align'];
    const ht = HORIZONTAL_ALIGNS.findIndex((align) => align === textAlign);
    if (ht >= 0) cell.ht = ht;

    // An alignment the sheet has no name for, such as baseline, lands at the bottom.
    const verticalAlign = td.style.verticalAlign || styles['vertical-align'] || tableVerticalAlign || 'top';
    const vt = VERTICAL_ALIGNS.findIndex((align) => align === (verticalAlign === 'text-top' ? 'top' : verticalAlign));
    cell.vt = vt >= 0 ? vt : VERTICAL_ALIGNS.indexOf('bottom');

    if ('mso-rotate' in styles) cell.rt = parseFloat(styles['mso-rotate']);
    return cell;
}
