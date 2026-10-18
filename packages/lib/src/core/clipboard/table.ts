// A block of cells on the clipboard: TSV on text/plain, as Google Sheets writes it (a cell holding a tab, a
// line break or a leading quote is quoted, its quotes doubled; a quote inside text stays as it is), and a
// <table> on text/html.
import { escapeHtml } from '../html';

const NEEDS_QUOTES = /[\t\n\r]|^"/;

export function cellsToTsv(rows: string[][]): string {
    return rows
        .map((row) =>
            row.map((cell) => (NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join('\t'),
        )
        .join('\n');
}

// A quoted field from the quote at `start`, or null when no quote closes it before a tab, a newline
// or the end, in which case the quote is text.
function readQuoted(source: string, start: number): { value: string; end: number } | null {
    let value = '';
    for (let i = start + 1; i < source.length; i += 1) {
        if (source[i] !== '"') {
            value += source[i];
        } else if (source[i + 1] === '"') {
            value += '"';
            i += 1;
        } else {
            const next = source[i + 1];
            return next === undefined || next === '\t' || next === '\n' ? { value, end: i + 1 } : null;
        }
    }
    return null;
}

export function parseTsv(text: string): string[][] {
    const source = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let i = 0;
    while (i <= source.length) {
        const quoted = source[i] === '"' ? readQuoted(source, i) : null;
        if (quoted) {
            row.push(quoted.value);
            i = quoted.end;
        } else {
            const end = source.slice(i).search(/[\t\n]/);
            const stop = end === -1 ? source.length : i + end;
            row.push(source.slice(i, stop));
            i = stop;
        }
        if (source[i] !== '\t') {
            rows.push(row);
            row = [];
        }
        i += 1;
    }
    return rows;
}

export function cellsToHtmlTable(rows: string[][]): string {
    const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    return `<table>${body}</table>`;
}

// A spanned cell pads the cells it covers, across its row and down the rows below, so the columns line up.
export function htmlTableCells(html: string): string[][] | null {
    const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
    if (!table) return null;
    // Google marks a line break inside a cell with <br>, which textContent drops.
    for (const br of table.querySelectorAll('br')) br.replaceWith('\n');
    const rows: string[][] = [...table.rows].map(() => []);
    for (const [r, row] of [...table.rows].entries()) {
        let c = 0;
        for (const cell of row.cells) {
            while (rows[r][c] !== undefined) c += 1;
            const below = Math.min(cell.rowSpan || 1, rows.length - r);
            for (let i = 0; i < below; i += 1) {
                for (let j = 0; j < cell.colSpan; j += 1) {
                    rows[r + i][c + j] = i === 0 && j === 0 ? (cell.textContent?.trim() ?? '') : '';
                }
            }
            c += cell.colSpan;
        }
    }
    return rows.map((row) => Array.from(row, (cell) => cell ?? ''));
}
