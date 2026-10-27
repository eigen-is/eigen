// A rich-text cell keeps its text as runs (`ct.s`): pieces of text, each with its own weight, slant,
// decoration, color, size and font. While the cell is open, the in-cell editor shows the same runs as
// spans. This module reads the editor's DOM back into runs, applies a toolbar format to the selected
// characters, writes the runs back as spans and puts the selection back. updateCell commits what
// committedRuns reads, so the cell gets what the editor shows.

import { escapeHtml } from '@workspace/lib/html';
import { cellFontName, SHEET_DEFAULT_FONT, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import type { Cell, CellStyle, InlineStringSegment } from '../../engine/types';
import { rgbToHex } from '../utils';

const RUN_STYLE_KEYS = ['bl', 'it', 'un', 'cl', 'fc', 'fs', 'ff'] as const;

export type RunStyleKey = (typeof RUN_STYLE_KEYS)[number];

// A run's whole look. A key a stored run leaves out is the default, as the canvas draws it.
export type RunStyle = { bl: number; it: number; un: number; cl: number; fc: string; fs: number; ff: string };

export type TextRun = RunStyle & { v: string };

type InlineStringCell = Cell & { ct: { t: 'inlineStr'; s: InlineStringSegment[] } };

// A format on a bare caret, waiting for the text typed there next, as in Google Sheets and Excel.
type PendingStyle = { at: number; base: RunStyle; style: Partial<RunStyle> };

const DEFAULT_COLOR = '#000000';

const TAG_STYLES: Record<string, Partial<RunStyle>> = {
    B: { bl: 1 },
    STRONG: { bl: 1 },
    I: { it: 1 },
    EM: { it: 1 },
    U: { un: 1 },
    S: { cl: 1 },
    STRIKE: { cl: 1 },
    DEL: { cl: 1 },
};

const BLOCK_TAGS = new Set(['DIV', 'P']);

// The editor's last selection survives a toolbar control taking the focus, such as the size box or
// the color popover, so the control formats the characters the user had selected.
const savedSelections = new WeakMap<HTMLElement, [number, number]>();
const pendingStyles = new WeakMap<HTMLElement, PendingStyle>();

export function isInlineStringCell(cell: Cell | null | undefined): cell is InlineStringCell {
    return cell?.ct?.t === 'inlineStr' && (cell?.ct?.s?.length ?? 0) > 0;
}

export function isRunStyleKey(key: string): key is RunStyleKey {
    return RUN_STYLE_KEYS.some((runKey) => runKey === key);
}

export function runStyleOf(style: CellStyle | null | undefined): RunStyle {
    return {
        bl: style?.bl ?? 0,
        it: style?.it ?? 0,
        un: style?.un ?? 0,
        cl: style?.cl ?? 0,
        fc: hexColor(style?.fc),
        fs: style?.fs ?? SHEET_DEFAULT_FONT_SIZE,
        ff: cellFontName(style?.ff) ?? SHEET_DEFAULT_FONT.name,
    };
}

// A format applied to a whole cell outside the editor reaches each of its runs too.
export function updateInlineStringFormatOutside(cell: Cell, key: RunStyleKey, value: string | number) {
    for (const run of cell.ct?.s ?? []) Object.assign(run, styleValue(key, value));
}

// The runs in the editor. Text outside any styled element has the cell's own style, which the editor
// box shows.
export function editorRuns(input: HTMLElement, cell: Cell | null | undefined): TextRun[] {
    return readRuns(input, runStyleOf(cell));
}

// The runs updateCell stores. A cell keeps a line break as \r\n. A contenteditable keeps one trailing
// break to show an empty last line, and that one is not the user's.
export function committedRuns(input: HTMLElement, cell: Cell | null | undefined): TextRun[] {
    const runs = editorRuns(input, cell);
    const last = runs.at(-1);
    if (last?.v.endsWith('\n') && !last.v.endsWith('\n\n')) last.v = last.v.slice(0, -1);
    return mergeRuns(runs.map((run) => ({ ...run, v: run.v.replace(/\n/g, '\r\n') })));
}

// Spans for the editor. A span states only where its run differs from `base`, the style the editor box
// shows, so text typed beside a span reads back with the box's style.
export function runsHtml(runs: readonly InlineStringSegment[], base: RunStyle): string {
    let html = '';
    for (const run of runs) {
        if (!run.v) continue;
        const css = escapeHtml(runCss(runStyleOf(run), base));
        html += `<span class="sheet-input-span" style="${css}">${escapeHtml(run.v)}</span>`;
    }
    return html;
}

export function sameRunStyle(a: RunStyle, b: RunStyle): boolean {
    return RUN_STYLE_KEYS.every((key) => a[key] === b[key]);
}

// Keeps the editor's selection while it is in the editor. A caret that moves drops a pending style.
export function rememberEditorSelection(input: HTMLElement) {
    const offsets = selectionOffsets(input);
    if (!offsets) return;
    savedSelections.set(input, offsets);
    const pending = pendingStyles.get(input);
    if (pending && (offsets[0] !== pending.at || offsets[1] !== pending.at)) pendingStyles.delete(input);
}

// Applies one format to the selected characters, or to the text typed next when only a caret is there.
export function formatEditorSelection(
    input: HTMLElement,
    cell: Cell | null | undefined,
    key: RunStyleKey,
    value: string | number,
) {
    const offsets = selectionOffsets(input) ?? savedSelections.get(input);
    if (!offsets) return;
    const [start, end] = offsets;
    const base = runStyleOf(cell);
    const style = styleValue(key, value);
    if (start === end) {
        const pending = pendingStyles.get(input);
        const earlier = pending?.at === start ? pending.style : {};
        pendingStyles.set(input, { at: start, base, style: { ...earlier, ...style } });
    } else {
        input.innerHTML = runsHtml(applyRunStyle(readRuns(input, base), start, end, style), base);
    }
    setSelectionOffsets(input, start, end);
}

// The style the toolbar shows while the cell is open: at a caret, the run left of it and any pending
// style; over a selection, each on/off format only when all of the selection has it.
export function editorSelectionStyle(input: HTMLElement, cell: Cell | null | undefined): RunStyle | null {
    const offsets = selectionOffsets(input) ?? savedSelections.get(input);
    if (!offsets) return null;
    const [start, end] = offsets;
    const base = runStyleOf(cell);
    const runs = readRuns(input, base);
    const from = splitAt(runs, start);
    if (start === end) {
        const pending = pendingStyles.get(input);
        const caret = runStyleOf(runs[from - 1] ?? runs[from] ?? base);
        return { ...caret, ...(pending?.at === start ? pending.style : {}) };
    }
    const selected = runs.slice(from, splitAt(runs, end));
    const style = runStyleOf(selected[0] ?? base);
    for (const key of ['bl', 'it', 'un', 'cl'] as const) {
        if (!selected.every((run) => run[key])) style[key] = 0;
    }
    return style;
}

// Types `text` at the caret in the pending style, if a format left one there. False leaves the typing to
// the browser.
export function typeWithPendingStyle(input: HTMLElement, text: string): boolean {
    const pending = pendingStyles.get(input);
    pendingStyles.delete(input);
    const offsets = selectionOffsets(input);
    if (!pending || !offsets || offsets[0] !== pending.at || offsets[1] !== pending.at) return false;
    const runs = readRuns(input, pending.base);
    const at = splitAt(runs, pending.at);
    const left = runs[at - 1] ?? runs[at] ?? pending.base;
    runs.splice(at, 0, { ...runStyleOf(left), ...pending.style, v: text });
    input.innerHTML = runsHtml(mergeRuns(runs), pending.base);
    setSelectionOffsets(input, pending.at + text.length, pending.at + text.length);
    return true;
}

function readRuns(root: Node, base: RunStyle): TextRun[] {
    const runs: TextRun[] = [];
    const visit = (node: Node, style: RunStyle) => {
        for (const child of node.childNodes) {
            if (isElement(child)) {
                if (child.tagName === 'BR' || (BLOCK_TAGS.has(child.tagName) && runs.length > 0)) {
                    appendRun(runs, { ...style, v: '\n' });
                }
                visit(child, elementStyle(child, style));
            } else if (child.nodeType === child.TEXT_NODE) {
                appendRun(runs, { ...style, v: child.textContent ?? '' });
            }
        }
    };
    visit(root, base);
    return runs;
}

function isElement(node: Node): node is HTMLElement {
    return node.nodeType === node.ELEMENT_NODE;
}

// The style an element gives its text: its tag, as the browser's own bold writes <b>, then its inline
// CSS, as a span of ours or a pasted one carries it.
function elementStyle(element: HTMLElement, inherited: RunStyle): RunStyle {
    const style = { ...inherited, ...TAG_STYLES[element.tagName] };
    const { fontWeight, fontStyle, color, fontSize, fontFamily } = element.style;
    const decoration = element.style.textDecorationLine || element.style.textDecoration;
    if (fontWeight) style.bl = fontWeight === 'bold' || fontWeight === 'bolder' || Number(fontWeight) >= 600 ? 1 : 0;
    if (fontStyle) style.it = fontStyle === 'normal' ? 0 : 1;
    if (decoration) {
        style.un = decoration.includes('underline') ? style.un || 1 : 0;
        style.cl = decoration.includes('line-through') ? 1 : 0;
    }
    if (color) style.fc = hexColor(color);
    const points = cssPoints(fontSize);
    if (points) style.fs = points;
    if (fontFamily) style.ff = cellFontName(fontFamily) ?? style.ff;
    return style;
}

// The size box writes points. A pasted span may carry pixels, which round to the half point.
function cssPoints(size: string): number | undefined {
    const match = /^([\d.]+)(pt|px)$/.exec(size);
    if (!match) return undefined;
    const value = Number.parseFloat(match[1]);
    return match[2] === 'pt' ? value : Math.round(value * 1.5) / 2;
}

// The browser hands a color back as rgb(), and runs store the hex the color picker writes.
function hexColor(color: string | undefined): string {
    if (!color) return DEFAULT_COLOR;
    return color.startsWith('rgb') ? rgbToHex(color) : color.toLowerCase();
}

function styleValue(key: RunStyleKey, value: string | number): Partial<RunStyle> {
    if (key === 'fc') return { fc: hexColor(String(value)) };
    if (key === 'ff') return { ff: cellFontName(value) ?? SHEET_DEFAULT_FONT.name };
    return { [key]: Number(value) };
}

function runCss(style: RunStyle, base: RunStyle): string {
    const css: string[] = [];
    if (style.bl !== base.bl) css.push(`font-weight:${style.bl ? 'bold' : 'normal'}`);
    if (style.it !== base.it) css.push(`font-style:${style.it ? 'italic' : 'normal'}`);
    if (style.un !== base.un || style.cl !== base.cl) {
        const lines = [style.un ? 'underline' : '', style.cl ? 'line-through' : ''].filter(Boolean);
        css.push(`text-decoration:${lines.join(' ') || 'none'}`);
    }
    if (style.fc !== base.fc) css.push(`color:${style.fc}`);
    if (style.fs !== base.fs) css.push(`font-size:${style.fs}pt`);
    if (style.ff !== base.ff) css.push(`font-family:"${style.ff.replace(/["\\]/g, '')}", sans-serif`);
    return css.join(';');
}

function appendRun(runs: TextRun[], run: TextRun) {
    if (run.v === '') return;
    const last = runs.at(-1);
    if (last && sameRunStyle(last, run)) last.v += run.v;
    else runs.push({ ...run });
}

function mergeRuns(runs: readonly TextRun[]): TextRun[] {
    const merged: TextRun[] = [];
    for (const run of runs) appendRun(merged, run);
    return merged;
}

function applyRunStyle(runs: TextRun[], start: number, end: number, style: Partial<RunStyle>): TextRun[] {
    const from = splitAt(runs, start);
    const to = splitAt(runs, end);
    return mergeRuns(runs.map((run, index) => (index >= from && index < to ? { ...run, ...style } : run)));
}

// Splits the run that `at` falls inside, so that a run starts there, and returns that run's index.
function splitAt(runs: TextRun[], at: number): number {
    let start = 0;
    for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        if (at === start) return index;
        if (at < start + run.v.length) {
            const cut = at - start;
            runs.splice(index, 1, { ...run, v: run.v.slice(0, cut) }, { ...run, v: run.v.slice(cut) });
            return index + 1;
        }
        start += run.v.length;
    }
    return runs.length;
}

// The selection as character offsets into the editor's text, or null when it is not in the editor.
function selectionOffsets(input: HTMLElement): [number, number] | null {
    const selection = input.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!input.contains(range.startContainer) || !input.contains(range.endContainer)) return null;
    return [
        textOffset(input, range.startContainer, range.startOffset),
        textOffset(input, range.endContainer, range.endOffset),
    ];
}

// Counted the way readRuns reads, so a <br> or a block is the one character it reads as.
function textOffset(input: HTMLElement, container: Node, offset: number): number {
    const before = input.ownerDocument.createRange();
    before.setStart(input, 0);
    before.setEnd(container, offset);
    let length = 0;
    for (const run of readRuns(before.cloneContents(), runStyleOf(null))) length += run.v.length;
    return length;
}

function setSelectionOffsets(input: HTMLElement, start: number, end: number) {
    const range = input.ownerDocument.createRange();
    range.setStart(...textPoint(input, start));
    range.setEnd(...textPoint(input, end));
    if (input.ownerDocument.activeElement !== input) input.focus({ preventScroll: true });
    const selection = input.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

// The point `at` characters into the editor's text. A point between two spans is the end of the left
// one, so typing there continues the run on the left.
function textPoint(input: HTMLElement, at: number): [Node, number] {
    let left = at;
    let last: [Node, number] = [input, 0];
    for (const node of textNodes(input)) {
        const length = node.textContent?.length ?? 0;
        if (left <= length) return [node, left];
        left -= length;
        last = [node, length];
    }
    return last;
}

function* textNodes(node: Node): Generator<Node> {
    for (const child of node.childNodes) {
        if (child.nodeType === child.TEXT_NODE) yield child;
        else yield* textNodes(child);
    }
}
