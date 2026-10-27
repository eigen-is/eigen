// The cell editor keeps rich text as a list of runs: it reads the editor's DOM into runs, applies a
// format to the selected characters, writes the runs back as spans and commits the same runs to the
// cell's `ct.s`. Each test drives the toolbar handler the user reaches and reads what the commit wrote.

import { beforeEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { getFontStyleByCell, getInlineStringHTML, updateCell } from '../../../state/modules/cell';
import type { RunStyleKey } from '../../../state/modules/inline-string';
import {
    editorRuns,
    editorSelectionStyle,
    rememberEditorSelection,
    typeWithPendingStyle,
} from '../../../state/modules/inline-string';
import {
    handleBold,
    handleFont,
    handleItalic,
    handleStrikeThrough,
    handleTextColor,
    handleTextSize,
    handleUnderline,
} from '../../../state/modules/toolbar';
import { contextFactory, selectionFactory } from '../factories/context';

installHappyDom();

function editing(html: string, cell: Cell | null = null) {
    const ctx = contextFactory({
        editingCellPosition: [0, 0],
        selections: selectionFactory([0, 0], [0, 0], 0, 0),
    }) as Context;
    ctx.sheets[0].data = [[cell, null]];
    const input = document.createElement('div');
    input.innerHTML = html;
    document.body.replaceChildren(input);
    return { ctx, input };
}

// The point `offset` characters into the text under `root`.
function textPoint(root: Node, offset: number): [Node, number] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (left <= length) return [node, left];
        left -= length;
    }
    throw new Error(`offset ${offset} is past the text`);
}

function select(root: Node, start: number, end = start) {
    const range = document.createRange();
    range.setStart(...textPoint(root, start));
    range.setEnd(...textPoint(root, end));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
}

function commit({ ctx, input }: { ctx: Context; input: HTMLDivElement }) {
    updateCell(ctx, 0, 0, input);
    return ctx.sheets[0].data?.[0][0];
}

function runs(cell: Cell | null | undefined, key: RunStyleKey = 'bl') {
    return cell?.ct?.s?.map((run) => [run.v, run[key]]);
}

beforeEach(() => {
    document.getSelection()?.removeAllRanges();
});

describe('a format on selected characters', () => {
    test('Bold on a word of a new cell commits it bold between plain runs', () => {
        const edit = editing('hello big world');
        select(edit.input, 6, 9);
        handleBold(edit.ctx, edit.input);
        expect(runs(commit(edit))).toEqual([
            ['hello ', 0],
            ['big', 1],
            [' world', 0],
        ]);
    });

    test('italic, underline, strike, color, font and size each set only their own key', () => {
        const formats: [RunStyleKey, (ctx: Context, input: HTMLDivElement) => void, string | number][] = [
            ['it', handleItalic, 1],
            ['un', handleUnderline, 1],
            ['cl', handleStrikeThrough, 1],
            ['fc', (ctx, input) => handleTextColor(ctx, input, '#ff0000'), '#ff0000'],
            ['ff', (ctx, input) => handleFont(ctx, input, 'Source Serif 4'), 'Source Serif 4'],
            ['fs', (ctx, input) => handleTextSize(ctx, input, 10.5), 10.5],
        ];
        for (const [key, format, value] of formats) {
            const edit = editing('hello big world');
            select(edit.input, 6, 9);
            format(edit.ctx, edit.input);
            const [before, word, after] = commit(edit)?.ct?.s ?? [];
            expect(word).toEqual({ ...before, v: 'big', [key]: value });
            expect(after).toEqual({ ...before, v: ' world' });
        }
    });

    test('a cell style object holds only the keys the cell sets', () => {
        expect(getFontStyleByCell({ fc: '#ff0000' })).toEqual({ color: '#ff0000' });
        expect(getFontStyleByCell({ it: 1 })).toEqual({ fontStyle: 'italic' });
        expect(getFontStyleByCell({ ff: 'Source Serif 4' })).toEqual({ fontFamily: "'Source Serif 4', sans-serif" });
    });

    test('text with &, < and > keeps every character', () => {
        const edit = editing('a &amp; b &lt;c&gt;');
        select(edit.input, 4, 5);
        handleBold(edit.ctx, edit.input);
        expect(runs(commit(edit))).toEqual([
            ['a & ', 0],
            ['b', 1],
            [' <c>', 0],
        ]);
    });

    test('a selection over the whole editor, a line break included, formats all of it', () => {
        const edit = editing('one<br>two');
        const range = document.createRange();
        range.selectNodeContents(edit.input);
        document.getSelection()?.addRange(range);
        handleItalic(edit.ctx, edit.input);
        expect(runs(commit(edit), 'it')).toEqual([['one\r\ntwo', 1]]);
    });

    test('a selection outside the editor changes nothing', () => {
        const edit = editing('hello');
        const elsewhere = document.createElement('p');
        elsewhere.textContent = 'elsewhere';
        document.body.append(elsewhere);
        select(elsewhere, 0, 4);
        handleBold(edit.ctx, edit.input);
        expect(edit.input.innerHTML).toBe('hello');
        expect(elsewhere.innerHTML).toBe('elsewhere');
    });

    test('Bold on a word of a bold cell takes the bold off that word', () => {
        const edit = editing('hello big world', { v: 'hello big world', m: 'hello big world', bl: 1 });
        select(edit.input, 6, 9);
        handleBold(edit.ctx, edit.input);
        expect(runs(commit(edit))).toEqual([
            ['hello ', 1],
            ['big', 0],
            [' world', 1],
        ]);
    });

    test('a cell whose text all has its own style commits plain', () => {
        const cell = commit(editing('typed', { v: 'old', m: 'old', bl: 1 }));
        expect(cell).toMatchObject({ v: 'typed', bl: 1 });
        expect(cell?.ct?.t).not.toBe('inlineStr');
    });

    test('the font size box formats the selection the editor had before it took the focus', () => {
        const edit = editing('hello big world');
        select(edit.input, 6, 9);
        rememberEditorSelection(edit.input);
        const sizeBox = document.createElement('input');
        document.body.append(sizeBox);
        sizeBox.focus();
        const range = document.createRange();
        range.setStart(sizeBox, 0);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        handleTextSize(edit.ctx, edit.input, 18);
        expect(runs(commit(edit), 'fs')).toEqual([
            ['hello ', 10],
            ['big', 18],
            [' world', 10],
        ]);
    });
});

describe('the editor DOM read into runs', () => {
    test("the browser's own bold markup and bare text commit with all their text", () => {
        expect(runs(commit(editing('hello <b>world</b>')))).toEqual([
            ['hello ', 0],
            ['world', 1],
        ]);
        expect(runs(commit(editing('<span>hel</span><span>lo </span><b>world</b>')))).toEqual([
            ['hello ', 0],
            ['world', 1],
        ]);
        expect(runs(commit(editing('<span style="font-weight: bold">a</span>b')))).toEqual([
            ['a', 1],
            ['b', 0],
        ]);
    });

    test('CSS reads as model values: a hex color, a font name, no decoration as no strike', () => {
        const edit = editing(
            '<span style="color: rgb(255, 0, 0); font-family: &quot;source serif 4&quot;, serif; text-decoration: none">a</span>b',
            { v: 'ab', m: 'ab', cl: 1 },
        );
        const [run] = editorRuns(edit.input, edit.ctx.sheets[0].data?.[0][0]);
        expect(run).toMatchObject({ v: 'a', fc: '#ff0000', ff: 'Source Serif 4', cl: 0 });
    });

    test('a rich cell opens as spans that read back as the same runs', () => {
        const stored = [
            { v: 'plain ', bl: 0, it: 0, un: 0, cl: 0, fc: '#000000', fs: 10, ff: 'Inter' },
            { v: "it's", bl: 1, it: 1, un: 1, cl: 1, fc: '#ff0000', fs: 14, ff: 'Source Serif 4' },
        ];
        const data = [[{ ct: { fa: 'General', t: 'inlineStr', s: stored } }]];
        const html = getInlineStringHTML(0, 0, data);
        // A family name with a digit in it is no CSS identifier, so it is a quoted string.
        expect(html).toContain('font-family:&quot;Source Serif 4&quot;, sans-serif');
        const edit = editing(html, data[0][0]);
        expect(editorRuns(edit.input, data[0][0])).toEqual(stored);
    });
});

describe('the style at the caret', () => {
    test('the toolbar reads the run left of the caret, and a selection is bold only when all of it is', () => {
        const edit = editing('hello <b>big</b> world');
        const cell = edit.ctx.sheets[0].data?.[0][0];
        select(edit.input, 9);
        expect(editorSelectionStyle(edit.input, cell)?.bl).toBe(1);
        select(edit.input, 6);
        expect(editorSelectionStyle(edit.input, cell)?.bl).toBe(0);
        select(edit.input, 7, 11);
        expect(editorSelectionStyle(edit.input, cell)?.bl).toBe(0);
        select(edit.input, 7, 9);
        expect(editorSelectionStyle(edit.input, cell)?.bl).toBe(1);
    });

    test('Bold with only a caret bolds the text typed next', () => {
        const edit = editing('hello world');
        select(edit.input, 6);
        handleBold(edit.ctx, edit.input);
        expect(editorSelectionStyle(edit.input, null)?.bl).toBe(1);
        expect(typeWithPendingStyle(edit.input, 'big ')).toBe(true);
        expect(runs(commit(edit))).toEqual([
            ['hello ', 0],
            ['big ', 1],
            ['world', 0],
        ]);
    });

    test('a caret moved away drops the pending style', () => {
        const edit = editing('hello world');
        select(edit.input, 6);
        handleBold(edit.ctx, edit.input);
        select(edit.input, 2);
        rememberEditorSelection(edit.input);
        expect(typeWithPendingStyle(edit.input, 'x')).toBe(false);
    });
});
