// What one cell of a pasted HTML table holds: its value and its look, read from the element and the table's <style>
// block as a program such as Excel writes them. A paste of a table reads each cell through these and places them.

import { bundledFontOfStack, readCssFontSize } from '@workspace/lib/constants/fonts';
import { SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { includes, isEmpty, trim } from 'es-toolkit/compat';
import { parseCellInput } from '../../engine/format';
import type { Cell } from '../../engine/types';

// Reads a pasted <style> block into each rule's declarations, keyed by selector. Office wraps the block in an
// HTML comment and writes properties a browser's own CSS parser drops, such as mso-rotate, so the paste reads
// the text itself. A rule for `td.xl65` is filed under `.xl65`. An at-rule such as @page or @media is skipped,
// with the rules nested inside it.
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

export function pastedCell(
    td: HTMLTableCellElement,
    styles: Record<string, string>,
    tableVerticalAlign: string | undefined,
): Cell {
    const cell: Cell = {};
    const txt = td.innerText || td.innerHTML;
    if (trim(txt).length === 0) {
        cell.v = undefined;
        cell.m = '';
    } else {
        [cell.m, cell.ct, cell.v] = parseCellInput(txt);
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
    const ht = td.style.textAlign || styles['text-align'];
    if (ht === 'center') cell.ht = 0;
    else if (ht === 'right') cell.ht = 2;
    else if (ht === 'left') cell.ht = 1;

    const vt = td.style.verticalAlign || styles['vertical-align'] || tableVerticalAlign || 'top';
    if (vt === 'middle') cell.vt = 0;
    else if (vt === 'top' || vt === 'text-top') cell.vt = 1;
    else cell.vt = 2;

    if ('mso-rotate' in styles) cell.rt = parseFloat(styles['mso-rotate']);
    return cell;
}
