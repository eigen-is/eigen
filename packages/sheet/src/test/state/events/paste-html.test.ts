import { describe, expect, it, spyOn } from 'bun:test';
import { SHEET_DEFAULT_FONT_SIZE, SHEET_DEFAULT_ROW_HEIGHT } from '@workspace/lib/sheets';
import { pick } from 'es-toolkit/compat';
import { Window } from 'happy-dom';
import { produce, produceWithPatches } from 'immer';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../../engine/defaults';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { handleCopy } from '../../../state/events/copy';
import { handlePaste } from '../../../state/events/paste';
import { normalizedCellAttr } from '../../../state/modules/cell';
import {
    COPY_ACTION_TABLE_MARKER,
    consumePendingCopy,
    copy,
    rangeValueToClipboard,
} from '../../../state/modules/clipboard';
import { filterPatch } from '../../../state/utils';
import { clipboardWith } from '../factories/clipboard';
import { syncablePaths } from '../factories/collab';
import { contextFactory, editInPlace } from '../factories/context';
import { pastedHtmlFactory } from '../factories/pasted-html';

// The branch reads the *global* `document` (not a passed-in window). Install a real
// happy-dom document at module scope so querySelectorAll / td.style / innerText /
// border CSSOM all resolve. This file is the only sheet test that needs a full DOM;
// the DOM-free siblings (paste.test.ts, clipboard-cut.test.ts, …) each overwrite
// g.document with their own stub at their own module scope, so ordering stays safe —
// proven by the full suite staying green. Not @happy-dom/global-registrator, which
// would leak DOM globals across the whole sheet test process.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.document = win.document;
g.DOMParser = win.DOMParser;

function grid(rows: number, cols: number): (Cell | null)[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

function single(r: number, c: number) {
    return [{ row: [r, r], column: [c, c], row_focus: r, column_focus: c }];
}

// A single-sheet ctx with an explicit rows x cols grid, selection anchored at (0,0).
function makeCtx(rows = 8, cols = 8): Context {
    return contextFactory({
        currentSheetId: 'id_1',
        selections: single(0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data: grid(rows, cols) }],
    }) as Context;
}

function pasteHtml(ctx: Context, html: string) {
    handlePaste(ctx, clipboardWith({ html }));
}

// Windows Excel indents each rule's declarations with a tab and Excel for Mac with spaces.
// This hand-written table pins the tab-indented shape, the committed Excel fixture the other.
const excelClassBlockHtml = `<html><head><style>
<!--table
\t{color:black;}
td
\t{color:black;font-weight:400;}
.xl65
\t{font-weight:700;}
.xl66
\t{color:#ED7D31;}
.xl67
\t{background:#ED7D31;}
.xl68
\t{text-decoration:underline;}
.xl69
\t{font-style:italic;}
-->
</style></head><body>
<table>
<tr><td class=xl65>2</td><td class=xl66>3</td></tr>
<tr><td class=xl67>4</td><td class=xl68>5</td></tr>
<tr><td class=xl69>6</td><td>7</td></tr>
</table></body></html>`;

describe('HTML-table paste — values and selection', () => {
    it('lands numeric cells as numbers and expands the selection to the pasted rectangle (Excel fixture)', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory('Excel'));

        const d = ctx.sheets[0].data!;
        // parseCellInput() masks the plain integers to numeric cells (ct.t === 'n')
        expect(d[0][0]?.v).toBe(1);
        expect(d[0][0]?.ct?.t).toBe('n');
        expect(d[0][1]?.v).toBe(2);
        expect(d[0][2]?.v).toBe(3);
        expect(d[1][0]?.v).toBe(3);
        expect(d[2][0]?.v).toBe(4);
        expect(d[3][0]?.v).toBe(5);
        // 4 rows x 3 cols pasted at anchor (0,0)
        expect(ctx.selections![0].row).toEqual([0, 3]);
        expect(ctx.selections![0].column).toEqual([0, 2]);
    });

    it('pastes at a non-origin anchor, offsetting every cell and the selection (WPS fixture at (2,2))', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 2);
        pasteHtml(ctx, pastedHtmlFactory('WPS'));

        const d = ctx.sheets[0].data!;
        expect(d[2][2]?.v).toBe(1);
        expect(d[2][3]?.bl).toBe(1); // bold '2' shifted
        expect(d[3][2]?.bg).toBe('#ED7D31'); // background '4' shifted
        expect(d[5][2]?.it).toBe(1); // italic '6' shifted
        expect(d[0][0]).toBeNull();
        expect(ctx.selections![0].row).toEqual([2, 5]);
        expect(ctx.selections![0].column).toEqual([2, 4]);
    });

    it('expands the grid when the pasted table is bigger than the remaining sheet', () => {
        const ctx = makeCtx(2, 2);
        pasteHtml(
            ctx,
            '<table>' +
                '<tr><td>a</td><td>b</td><td>c</td></tr>' +
                '<tr><td>d</td><td>e</td><td>f</td></tr>' +
                '<tr><td>g</td><td>h</td><td>i</td></tr>' +
                '</table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d.length).toBe(3);
        expect(d[0].length).toBe(3);
        expect(d[0][0]?.v).toBe('a');
        expect(d[2][2]?.v).toBe('i');
        expect(ctx.selections![0].row).toEqual([0, 2]);
        expect(ctx.selections![0].column).toEqual([0, 2]);
    });
});

describe('HTML-table paste — style extraction', () => {
    it('reads bold / font-color / background / underline / italic from the <style> class block', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, excelClassBlockHtml);

        const d = ctx.sheets[0].data!;
        // values confirm the table itself parsed
        expect(d[0][0]?.v).toBe(2);
        expect(d[2][1]?.v).toBe(7);
        // styles come from the .xl6x class rules
        expect(d[0][0]?.bl).toBe(1); // .xl65 font-weight:700
        expect(d[0][1]?.fc).toBe('#ED7D31'); // .xl66 color
        expect(d[1][0]?.bg).toBe('#ED7D31'); // .xl67 background
        expect(d[1][1]?.un).toBe(1); // .xl68 text-decoration:underline
        expect(d[2][0]?.it).toBe(1); // .xl69 font-style:italic
    });

    it('reads the same class block when the properties are space-indented (Excel for Mac fixture)', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory('Excel'));

        const d = ctx.sheets[0].data!;
        expect(d[0][1]?.bl).toBe(1); // .xl65 font-weight:700
        expect(d[0][2]?.fc).toBe('#ED7D31'); // .xl66 color
        expect(d[1][0]?.bg).toBe('#ED7D31'); // .xl67 background
        expect(d[2][0]?.un).toBe(1); // .xl68 text-decoration:underline
        expect(d[3][0]?.it).toBe(1); // .xl69 font-style:italic
    });

    it('reads bold / font-color / background / underline / italic from inline td.style (WPS fixture)', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory('WPS'));

        const d = ctx.sheets[0].data!;
        expect(d[0][1]?.bl).toBe(1); // font-weight:700
        expect(d[0][2]?.bl).toBe(1);
        expect(d[0][2]?.fc).toBe('#ED7D31'); // color
        expect(d[1][0]?.bg).toBe('#ED7D31'); // background
        expect(d[3][0]?.it).toBe(1); // font-style:italic
        expect(d[2][0]?.un).toBe(1); // text-decoration:underline
        expect(d[0][0]?.un).toBeUndefined(); // text-decoration:none stays un-set
    });

    it.each([
        ["'Times New Roman', serif", 'Source Serif 4'],
        ['"Source Serif 4", serif', 'Source Serif 4'],
        ['Calibri', 'Inter'],
        ['Wingdings, "Courier New", monospace', 'JetBrains Mono'],
    ])('a td in %s pastes in %s', (stack, font) => {
        const ctx = makeCtx();
        pasteHtml(ctx, `<table><tr><td style="font-family: ${stack.replaceAll('"', '&quot;')}">x</td></tr></table>`);
        expect(ctx.sheets[0].data![0][0]?.ff).toBe(font);
    });

    it('a td in a font the map does not know, or in none, keeps the sheet default', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td style="font-family: Wingdings">x</td><td>y</td></tr></table>');
        expect(ctx.sheets[0].data![0][0]?.ff).toBeUndefined();
        expect(ctx.sheets[0].data![0][1]?.ff).toBeUndefined();
    });

    // Eigen's own copy writes a size inline in pt; a web page's is often px, which is 3/4 pt at 96 dpi.
    it('reads a font size in pt as pt and in px at 96 dpi, inline or from the class block', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            '<html><head><style>\n<!--td\n\t{color:black;}\n.xl72\n\t{font-size:16px;}\n.xl73\n\t{font-size:12.0pt;}\n-->\n</style></head><body><table><tr>' +
                '<td style="font-size:14pt">a</td>' +
                '<td style="font-size:16px">b</td>' +
                '<td class=xl72>c</td>' +
                '<td class=xl73>d</td>' +
                '<td>e</td>' +
                '</tr></table></body></html>',
        );

        expect(ctx.sheets[0].data![0].slice(0, 5).map((cell) => cell?.fs)).toEqual([
            14,
            12,
            12,
            12,
            SHEET_DEFAULT_FONT_SIZE,
        ]);
    });

    it('sets cl=1 for a <s> strikethrough inside the td', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td><s>x</s></td></tr></table>');

        expect(ctx.sheets[0].data![0][0]?.cl).toBe(1);
    });

    // Our own HTML export writes the strikethrough as a text-decoration, never an <s> —
    // export a sheet and paste the table back and the marking has to survive.
    it('sets cl=1 for text-decoration:line-through, inline or from the class block', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            '<html><head><style>\n<!--td\n\t{color:black;}\n.xl70\n\t{text-decoration:line-through;}\n-->\n</style></head><body><table><tr>' +
                '<td style="text-decoration:line-through">x</td>' +
                '<td style="text-decoration:underline line-through">y</td>' +
                '<td class=xl70>z</td>' +
                '<td>plain</td>' +
                '</tr></table></body></html>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.cl).toBe(1);
        expect(d[0][1]?.cl).toBe(1);
        expect(d[0][1]?.un).toBe(1);
        expect(d[0][2]?.cl).toBe(1);
        expect(d[0][3]?.cl).toBeUndefined();
    });

    it('reads a class block whose properties carry spaces around the colon and the brace', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            '<html><head><style>\n<!--td\n\t{color:black;}\n.xl71\n   { font-weight: 700;\n     color: #ED7D31; }\n-->\n</style></head>' +
                '<body><table><tr><td class=xl71>v</td></tr></table></body></html>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.bl).toBe(1);
        expect(d[0][0]?.fc).toBe('#ED7D31');
    });

    it('maps text-align to ht (right=2/center=0/left=1) and vertical-align to vt (middle=0/top=1/bottom=2)', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            '<table><tr>' +
                '<td style="text-align:right;vertical-align:middle">r</td>' +
                '<td style="text-align:center;vertical-align:top">c</td>' +
                '<td style="text-align:left;vertical-align:bottom">l</td>' +
                '</tr></table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.ht).toBe(2);
        expect(d[0][0]?.vt).toBe(0);
        expect(d[0][1]?.ht).toBe(0);
        expect(d[0][1]?.vt).toBe(1);
        expect(d[0][2]?.ht).toBe(1);
        expect(d[0][2]?.vt).toBe(2);
    });

    it('leaves a cell with no text-align to its value, so a number lands on the right', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td>12</td><td>word</td></tr></table>');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe(12);
        expect(d[0][0]?.ht).toBeUndefined();
        expect(normalizedCellAttr(d[0][0] ?? {}, 'ht')).toBe('2');
        expect(normalizedCellAttr(d[0][1] ?? {}, 'ht')).toBe('1');
    });
});

// The style fields a pasted cell can take from the <style> block, read from the top-left rows x cols.
function styleGrid(ctx: Context, rows: number, cols: number) {
    return (ctx.sheets[0].data ?? [])
        .slice(0, rows)
        .map((row) =>
            row
                .slice(0, cols)
                .map((cell) => pick(cell, ['bl', 'it', 'un', 'cl', 'ff', 'fs', 'fc', 'bg', 'ht', 'vt', 'rt'])),
        );
}

function styleBlockHtml(css: string, cells: string): string {
    return `<html><head><style>${css}</style></head><body><table><tr>${cells}</tr></table></body></html>`;
}

describe('HTML-table paste — the <style> block', () => {
    // A td the block styles only through its td rule: Excel's and WPS's both say vertical-align:middle.
    const plain = { bl: 0, it: 0, fs: SHEET_DEFAULT_FONT_SIZE, vt: 0 };
    const wps = { ...plain, fs: 12, fc: '#000000' };

    it.each<['Excel' | 'WPS', Partial<Cell>[][]]>([
        [
            'Excel',
            [
                [plain, { ...plain, bl: 1 }, { ...plain, fc: '#ED7D31' }],
                [{ ...plain, bg: '#ED7D31' }, plain, plain],
                [{ ...plain, un: 1 }, plain, plain],
                [{ ...plain, it: 1 }, plain, plain],
            ],
        ],
        [
            'WPS',
            [
                [wps, { ...wps, bl: 1 }, { ...wps, bl: 1, fc: '#ED7D31' }],
                [{ ...wps, bg: '#ED7D31' }, plain, plain],
                [{ ...wps, un: 1 }, plain, plain],
                [{ ...wps, it: 1 }, plain, plain],
            ],
        ],
    ])('styles every cell of the %s fixture from its inline styles and its rules', (source, expected) => {
        const ctx = makeCtx();
        pasteHtml(ctx, pastedHtmlFactory(source));
        expect(styleGrid(ctx, 4, 3)).toEqual(expected);
    });

    it('styles every cell of the tab-indented Excel block', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, excelClassBlockHtml);
        const top = { ...plain, vt: 1 };
        expect(styleGrid(ctx, 3, 2)).toEqual([
            [
                { ...top, bl: 1 },
                { ...top, fc: '#ED7D31' },
            ],
            [
                { ...top, bg: '#ED7D31' },
                { ...top, un: 1 },
            ],
            [{ ...top, it: 1 }, top],
        ]);
    });

    it('reads a block written on one line, several declarations to a rule', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            styleBlockHtml(
                '<!--td {vertical-align:bottom;}.c1 {font-weight:700;color:#ED7D31;mso-rotate:90}-->',
                '<td class=c1>a</td><td>b</td>',
            ),
        );
        expect(styleGrid(ctx, 1, 2)).toEqual([
            [
                { ...plain, bl: 1, fc: '#ED7D31', rt: 90, vt: 2 },
                { ...plain, vt: 2 },
            ],
        ]);
    });

    it('skips comments and at-rules, nested rules included', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            styleBlockHtml(
                '@page {margin:1in;} @media print { .xl65 {font-weight:700;} } /* .xl65 {color:red;} */ .xl66 {font-style:italic;}',
                '<td class=xl65>a</td><td class=xl66>b</td>',
            ),
        );
        expect(styleGrid(ctx, 1, 2)).toEqual([
            [
                { ...plain, vt: 1 },
                { ...plain, vt: 1, it: 1 },
            ],
        ]);
    });

    it('reads td.xlNN and selector lists, and keeps a semicolon inside quotes in its value', () => {
        const ctx = makeCtx();
        pasteHtml(
            ctx,
            styleBlockHtml(
                'td.xl65, .xl66 {font-family:"Wingdings;x", "Courier New", monospace; font-weight:700;}',
                '<td class=xl65>a</td><td class=xl66>b</td>',
            ),
        );
        const mono = { ...plain, vt: 1, bl: 1, ff: 'JetBrains Mono' };
        expect(styleGrid(ctx, 1, 2)).toEqual([[mono, mono]]);
    });
});

// A cut's formula follows Excel's rule for a move: its refs into the moved block follow the cells.
describe('a cut landing its own formulas', () => {
    function cutAndPaste(ctx: Context, from: Context['selections'], at: number[]) {
        editInPlace(ctx, (draft) => {
            draft.selections = from;
            handleCopy(draft, { cut: true });
            const pending = consumePendingCopy();
            draft.selections = single(at[0], at[1]);
            handlePaste(draft, clipboardWith({ html: pending?.html ?? '' }));
        });
    }

    it('rewrites a ref into the block and computes it where it landed', () => {
        const ctx = makeCtx(8, 10);
        const d = ctx.sheets[0].data!;
        d[4][3] = { v: 10, m: '10', ct: { fa: 'General', t: 'n' } };
        d[4][4] = { f: '=D5*2', v: 20, m: '20', ct: { fa: 'General', t: 'n' } };
        cutAndPaste(ctx, [{ row: [4, 4], column: [3, 4], row_focus: 4, column_focus: 3 }], [2, 6]);

        const landed = ctx.sheets[0].data!;
        expect(landed[2][7]?.f).toBe('=G3*2');
        expect(landed[2][7]?.v).toBe(20);
        expect(landed[4][4]).toBeNull();
    });

    it('keeps a ref outside the block where it pointed', () => {
        const ctx = makeCtx(8, 10);
        const d = ctx.sheets[0].data!;
        d[0][0] = { v: 3, m: '3', ct: { fa: 'General', t: 'n' } };
        d[4][4] = { f: '=A1*2', v: 6, m: '6', ct: { fa: 'General', t: 'n' } };
        cutAndPaste(ctx, single(4, 4), [2, 6]);

        const landed = ctx.sheets[0].data!;
        expect(landed[2][6]?.f).toBe('=A1*2');
        expect(landed[2][6]?.v).toBe(6);
    });
});

describe('HTML-table paste — merges, borders, row height', () => {
    it('turns a rowspan=2 colspan=2 td into one merge entry, an anchor mc, and offsetMC-filled covered cells', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td rowspan=2 colspan=2>M</td><td>b</td></tr><tr><td>c</td></tr></table>');

        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('M');
        expect(d[0][0]?.mc).toEqual({ r: 0, c: 0, rs: 2, cs: 2 });
        // the three covered cells point back at the anchor via the offsetMC remap
        expect(d[0][1]?.mc).toEqual({ r: 0, c: 0 });
        expect(d[1][0]?.mc).toEqual({ r: 0, c: 0 });
        expect(d[1][1]?.mc).toEqual({ r: 0, c: 0 });
        // the second-row td flows past the merged span into column 2
        expect(d[0][2]?.v).toBe('b');
        expect(d[1][2]?.v).toBe('c');
        expect(ctx.sheets[0].config!.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
    });

    it('decomposes an inline td border into a cfg.borderInfo entry via getQKBorder', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td style="border:1px solid #0000ff">B</td></tr></table>');

        // 1px solid -> getQKBorder style 1; color passes through verbatim
        expect(ctx.sheets[0].config!.borderInfo!['0_0']).toEqual({
            l: { style: 1, color: '#0000ff' },
            r: { style: 1, color: '#0000ff' },
            t: { style: 1, color: '#0000ff' },
            b: { style: 1, color: '#0000ff' },
        });
    });

    it('a td without a border clears the border the destination cell had (paste with formatting)', () => {
        const ctx = makeCtx();
        const side = { style: 1, color: '#0000ff' };
        ctx.sheets[0].config = { borderInfo: { '0_0': { l: side, r: side, t: side, b: side }, '5_5': { l: side } } };
        pasteHtml(ctx, '<table><tr><td>plain</td></tr></table>');

        expect(ctx.sheets[0].data![0][0]?.v).toBe('plain');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({ '5_5': { l: side } });
    });

    it('keys merges and borders correctly at a non-origin anchor (absolute vs relative coordinates)', () => {
        // cfg.merge/mc use absolute coordinates while the borderInfo lookup is
        // relative (`${h - minh}_${c - minc}`); at anchor (0,0) the two coincide,
        // so only a shifted anchor can catch a refactor that mixes them up.
        const ctx = makeCtx();
        ctx.selections = single(3, 2);
        pasteHtml(
            ctx,
            '<table><tr><td rowspan=2 colspan=2 style="border:1px solid #0000ff">M</td><td>b</td></tr><tr><td>c</td></tr></table>',
        );

        const d = ctx.sheets[0].data!;
        expect(d[3][2]?.v).toBe('M');
        expect(d[3][2]?.mc).toEqual({ r: 3, c: 2, rs: 2, cs: 2 });
        expect(d[3][3]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[4][2]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[4][3]?.mc).toEqual({ r: 3, c: 2 });
        expect(d[3][4]?.v).toBe('b');
        expect(d[4][4]?.v).toBe('c');
        expect(ctx.sheets[0].config!.merge).toEqual({ '3_2': { r: 3, c: 2, rs: 2, cs: 2 } });

        // outer edges of the merged 2x2 block, at absolute row/col indices
        const side = { style: 1, color: '#0000ff' };
        const borderInfo = ctx.sheets[0].config!.borderInfo!;
        expect(borderInfo['3_2']?.t).toEqual(side);
        expect(borderInfo['3_2']?.l).toEqual(side);
        expect(borderInfo['3_2']?.b).toBeUndefined();
        expect(borderInfo['4_3']?.b).toEqual(side);
        expect(borderInfo['4_3']?.r).toEqual(side);
        expect(borderInfo['4_3']?.t).toBeUndefined();
    });

    it('writes a tr height attribute into cfg.rowlen at the target row', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 1);
        pasteHtml(ctx, '<table><tr height=30><td>a</td></tr></table>');

        expect(ctx.sheets[0].config!.rowlen![2]).toBe(30);
        expect(ctx.sheets[0].data![2][1]?.v).toBe('a');
    });

    it('writes no rowlen for a tr at the default row height', () => {
        const ctx = makeCtx();
        ctx.defaultrowlen = SHEET_DEFAULT_ROW_HEIGHT;
        ctx.selections = single(2, 1);
        pasteHtml(ctx, `<table><tr height=${SHEET_DEFAULT_ROW_HEIGHT}><td>a</td></tr></table>`);

        expect(ctx.sheets[0].config?.rowlen?.[2]).toBeUndefined();
    });

    it('leaves cfg.rowlen untouched for a tr with no height attribute', () => {
        const ctx = makeCtx();
        ctx.selections = single(2, 1);
        ctx.sheets[0].config = { rowlen: { 2: 42 } };
        pasteHtml(ctx, '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>');

        const rowlen = ctx.sheets[0].config!.rowlen!;
        expect(rowlen[2]).toBe(42); // a height the user set survives the paste
        expect(rowlen[3]).toBeUndefined(); // and no entry is invented for a row with none
        expect(ctx.sheets[0].data![3][1]?.v).toBe('b');
    });

    it('refuses a paste that would partially cover an existing merge (hasPartMC guard)', () => {
        const ctx = makeCtx(6, 6);
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        // paste a 2x1 table starting inside the merge and crossing its bottom edge
        ctx.selections = single(1, 0);
        pasteHtml(ctx, '<table><tr><td>9</td></tr><tr><td>8</td></tr></table>');

        const d = ctx.sheets[0].data!;
        // nothing written — the guard bailed out, the merge survives untouched
        expect(d[1][0]).toBeNull();
        expect(d[2][0]).toBeNull();
        expect(ctx.sheets[0].config!.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
        expect(ctx.warnDialog).toBe('Cannot perform this operation on merged cells');
    });

    it('replaces a merge it covers whole, as a paste of this tab does', () => {
        const ctx = makeCtx(6, 6);
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        ctx.sheets[0].data![0][0] = { v: 'merged', mc: { r: 0, c: 0, rs: 2, cs: 2 } };
        ctx.sheets[0].data![0][1] = { mc: { r: 0, c: 0 } };
        ctx.sheets[0].data![1][0] = { mc: { r: 0, c: 0 } };
        ctx.sheets[0].data![1][1] = { mc: { r: 0, c: 0 } };
        pasteHtml(ctx, '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');

        const d = ctx.sheets[0].data!;
        expect(ctx.sheets[0].config!.merge).toEqual({});
        expect([d[0][0]?.v, d[0][1]?.v, d[1][0]?.v, d[1][1]?.v]).toEqual(['a', 'b', 'c', 'd']);
        expect(d[1][1]?.mc).toBeUndefined();
        expect(ctx.warnDialog).toBeUndefined();
    });

    // HTML ends a span at the table's edge, so a merge does too.
    it('ends a rowspan or a colspan that runs past the table at its edge', () => {
        const ctx = makeCtx();
        pasteHtml(ctx, '<table><tr><td rowspan="5">tall</td><td>b</td></tr><tr><td colspan="9">wide</td></tr></table>');

        expect(ctx.sheets[0].config!.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 1 } });
        const d = ctx.sheets[0].data!;
        expect(d[0][0]?.v).toBe('tall');
        expect(d[1][1]?.v).toBe('wide');
        expect(d[1][1]?.mc).toBeUndefined();
        expect(d[2][0]).toBeNull();
    });
});

// A refused paste ships no op and takes no undo step, whatever the table carries.
describe('a refused paste writes nothing', () => {
    const table = '<table><tr height="50"><td>9</td></tr><tr height="60"><td>8</td></tr></table>';

    it('a table over part of a merge leaves the row heights alone', () => {
        const ctx = makeCtx(6, 6);
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } };
        ctx.selections = single(1, 0);
        expect(syncablePaths(ctx, (draft: Context) => pasteHtml(draft, table))).toEqual([]);
    });

    const limit = `This action would increase the number of rows in the workbook above the limit of ${MAX_SHEET_ROW_COUNT}.`;
    const atLastRow = (draft: Context) => {
        draft.selections = single(MAX_SHEET_ROW_COUNT - 1, 0);
    };

    it('a table past the row limit says so and writes nothing', () => {
        const ctx = makeCtx(MAX_SHEET_ROW_COUNT, 1);
        const [next, patches] = produceWithPatches(ctx, (draft: Context) => {
            atLastRow(draft);
            pasteHtml(draft, table);
        });
        expect(filterPatch(patches)).toEqual([]);
        expect(next.warnDialog).toBe(limit);
    });

    it('text past the column limit says so and writes nothing', () => {
        const ctx = makeCtx(1, MAX_SHEET_COLUMN_COUNT);
        const [next, patches] = produceWithPatches(ctx, (draft: Context) => {
            draft.selections = single(0, MAX_SHEET_COLUMN_COUNT - 1);
            handlePaste(draft, clipboardWith({ text: '9\t8' }));
        });
        expect(filterPatch(patches)).toEqual([]);
        expect(next.warnDialog).toBe(
            `This action would increase the number of columns in the workbook above the limit of ${MAX_SHEET_COLUMN_COUNT}.`,
        );
    });

    for (const cut of [false, true]) {
        it(`a ${cut ? 'cut' : 'copy'} past the row limit says so and writes nothing`, () => {
            const ctx = makeCtx(MAX_SHEET_ROW_COUNT, 1);
            ctx.copyState = { id: 'own', cut, dataSheetId: 'id_1', copyRange: [{ row: [0, 1], column: [0, 0] }] };
            const [next, patches] = produceWithPatches(ctx, (draft: Context) => {
                atLastRow(draft);
                pasteHtml(draft, '<table data-copy-id="own"></table>');
            });
            expect(filterPatch(patches)).toEqual([]);
            expect(next.warnDialog).toBe(limit);
        });
    }

    it('a table that fits still sets its row heights', () => {
        const ctx = makeCtx(6, 6);
        const next = produce(ctx, (draft: Context) => pasteHtml(draft, table));
        expect(next.sheets[0].config?.rowlen).toEqual({ 0: 50, 1: 60 });
    });
});

// OS clipboard HTML assigned to a live <div> loads <img> and fires its onerror even while
// detached, so a crafted clipboard would run script on the Eigen origin. The paste parses
// into an inert DOMParser document instead.
describe('HTML-table paste — inert parsing (no live image load)', () => {
    it('parses clipboard HTML into an inert document, never a live <div>, so an <img onerror> cannot fire', () => {
        const ctx = makeCtx();
        const createSpy = spyOn(g.document, 'createElement');
        // Read mock.calls before mockRestore() — restoring clears the recorded calls.
        let madeDiv = true;
        try {
            pasteHtml(
                ctx,
                '<table><tr><td>safe</td>' + '<td><img src="x" onerror="globalThis.__pwned = true"></td></tr></table>',
            );
            madeDiv = createSpy.mock.calls.some((args) => args[0] === 'div');
        } finally {
            createSpy.mockRestore();
        }

        // The table still pastes — the first cell keeps its value.
        expect(ctx.sheets[0].data![0][0]?.v).toBe('safe');
        // happy-dom never loads images, so onerror can't fire here regardless; the real
        // guarantee is structural — the branch parses into an inert document and never
        // assigns to a live <div>, whose innerHTML would load the image in a browser.
        expect((g as { __pwned?: boolean }).__pwned).toBeUndefined();
        expect(madeDiv).toBe(false);
    });
});

describe('Copy HTML — numeric cells carry their full value', () => {
    function copiedHtml(cell: Cell): string {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][0] = cell;
        return rangeValueToClipboard(ctx, 'id_1', [{ row: [0, 0], column: [0, 0] }])?.html ?? '';
    }

    it('a General number too long for General pastes back whole', () => {
        const html = copiedHtml({ v: 123456789012, m: '1.23457E+11', ct: { fa: 'General', t: 'n' } });
        expect(html).toContain('>123456789012<');

        const target = makeCtx();
        pasteHtml(target, html);
        expect(target.sheets[0].data![0][0]?.v).toBe(123456789012);
    });

    it('float noise stays hidden at 15 significant digits', () => {
        expect(copiedHtml({ v: 0.1 + 0.2, m: '0.3', ct: { fa: 'General', t: 'n' } })).toContain('>0.3<');
    });

    it('a masked number copies its display', () => {
        expect(copiedHtml({ v: 0.4072, m: '40.72%', ct: { fa: '0.00%', t: 'n' } })).toContain('>40.72%<');
    });

    it('a copy pasted back into its own sheet still takes the internal path', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][0] = { v: 123456789012, m: '1.23457E+11', f: '=A2', ct: { fa: 'General', t: 'n' } };
        ctx.selections = single(0, 0);
        copy(ctx);
        const html = consumePendingCopy()?.html ?? '';
        ctx.selections = single(0, 1);
        pasteHtml(ctx, html);
        expect(ctx.sheets[0].data![0][1]?.f).toBe('=B2');
    });
});

// A paste is this tab's copy exactly when the table carries the id of the copy. Another tab's table carries another id.
describe('HTML-table paste — the copy of this tab', () => {
    function rangeSel(r1: number, r2: number, c1: number, c2: number) {
        return [{ row: [r1, r2], column: [c1, c2], row_focus: r1, column_focus: c1 }];
    }

    // Copies rows x cols cells from A1, the formulas =1, =2, …, and returns the table the copy wrote.
    function copyCells(ctx: Context, rows: number, cols: number, { cut = false } = {}): string {
        const d = ctx.sheets[0].data ?? [];
        for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
                const n = r * cols + c + 1;
                d[r][c] = { v: n, m: String(n), f: `=${n}` };
            }
        }
        ctx.selections = rangeSel(0, rows - 1, 0, cols - 1);
        handleCopy(ctx, { cut });
        return consumePendingCopy()?.html ?? '';
    }

    function pasteAt(ctx: Context, html: string, r: number, c: number) {
        editInPlace(ctx, (draft) => {
            draft.selections = single(r, c);
            pasteHtml(draft, html);
        });
    }

    it('takes the copy state for its own table, with a merge in it', () => {
        const ctx = makeCtx(10, 10);
        const d = ctx.sheets[0].data ?? [];
        d[0][0] = { v: 'a', m: 'a', mc: { r: 0, c: 0, rs: 1, cs: 2 } };
        d[0][1] = { mc: { r: 0, c: 0 } };
        d[1][1] = { v: 1, m: '1', f: '=1' };
        ctx.sheets[0].config = { merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } } };
        ctx.selections = rangeSel(0, 1, 0, 1);
        handleCopy(ctx);
        pasteAt(ctx, consumePendingCopy()?.html ?? '', 4, 4);
        expect(ctx.sheets[0].data?.[5][5]?.f).toBe('=1');
        expect(ctx.sheets[0].config?.merge?.['4_4']).toEqual({ r: 4, c: 4, rs: 1, cs: 2 });
    });

    it('pastes a table with the same texts and another id as a table', () => {
        const ctx = makeCtx(10, 10);
        const html = copyCells(ctx, 1, 2).replace(/data-copy-id="[^"]*"/, 'data-copy-id="another-tab"');
        expect(html).toContain(COPY_ACTION_TABLE_MARKER);
        pasteAt(ctx, html, 2, 2);
        expect(pick(ctx.sheets[0].data?.[2][3], ['v', 'f'])).toEqual({ v: 2 });
    });

    it('lands the live cells of its own copy once they changed', () => {
        const ctx = makeCtx(10, 10);
        const html = copyCells(ctx, 1, 2);
        ctx.sheets[0].data?.[0].splice(1, 1, { v: 9, m: '9' });
        pasteAt(ctx, html, 2, 2);
        expect(pick(ctx.sheets[0].data?.[2][3], ['v', 'f'])).toEqual({ v: 9 });
        expect(ctx.sheets[0].data?.[2][2]?.f).toBe('=1');
    });

    it('pastes its own table as a table once the copied sheet is gone', () => {
        const ctx = makeCtx(10, 10);
        ctx.sheets.push({ name: 'other', id: 'id_2', order: 1, data: grid(10, 10) });
        const html = copyCells(ctx, 1, 1);
        ctx.sheets.shift();
        ctx.currentSheetId = 'id_2';
        pasteAt(ctx, html, 2, 2);
        expect(pick(ctx.sheets[0].data?.[2][2], ['v', 'f'])).toEqual({ v: 1 });
    });

    it('takes the cut state for a cut that grows the grid, and the cut is over', () => {
        const ctx = makeCtx(8, 8);
        const html = copyCells(ctx, 2, 2, { cut: true });
        pasteAt(ctx, html, 7, 7);
        const d = ctx.sheets[0].data ?? [];
        expect([d.length, d[0].length]).toEqual([9, 9]);
        expect(d[8][8]?.f).toBe('=4');
        expect(d[0][0]).toBeNull();
        expect(ctx.copyState).toBeUndefined();
        expect(ctx.formulaRangeSelections).toEqual([]);
    });

    it('keeps a cut a merge refused, so it can land elsewhere', () => {
        const ctx = makeCtx(10, 10);
        const html = copyCells(ctx, 1, 1, { cut: true });
        ctx.sheets[0].config = { merge: { '5_5': { r: 5, c: 5, rs: 2, cs: 2 } } };
        pasteAt(ctx, html, 6, 5);
        expect(ctx.sheets[0].data?.[0][0]?.f).toBe('=1');
        expect(ctx.copyState?.cut).toBe(true);
        pasteAt(ctx, html, 2, 2);
        expect(ctx.sheets[0].data?.[2][2]?.f).toBe('=1');
        expect(ctx.sheets[0].data?.[0][0]).toBeNull();
    });
});

// A plain paste reads what the clipboard holds as what it is: a word in the text is no table, and nothing is no value.
describe('paste of no table', () => {
    it('a paste into several ranges does nothing', () => {
        const ctx = makeCtx();
        ctx.selections = [...single(0, 0), ...single(2, 2)];
        handlePaste(ctx, clipboardWith({ text: '=1+1' }));
        expect(ctx.sheets[0].data?.[0][0]).toBeNull();
    });

    it('pastes text that names a table as text', () => {
        const ctx = makeCtx();
        handlePaste(ctx, clipboardWith({ text: 'my table' }));
        expect(ctx.sheets[0].data?.[0][0]?.v).toBe('my table');
    });

    it('takes the plain text of HTML that holds no table', () => {
        const ctx = makeCtx();
        handlePaste(ctx, clipboardWith({ html: '<p>a table of contents</p>', text: 'a table of contents' }));
        expect(ctx.sheets[0].data?.[0][0]?.v).toBe('a table of contents');
    });

    it('an empty clipboard leaves the cell alone', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data?.[0].splice(0, 1, { v: 'kept', m: 'kept' });
        handlePaste(ctx, clipboardWith({}));
        expect(ctx.sheets[0].data?.[0][0]?.v).toBe('kept');
    });
});
