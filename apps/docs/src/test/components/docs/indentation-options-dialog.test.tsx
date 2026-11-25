// Google Docs' Indentation options: the left and right indent in centimeters, and a first line or hanging indent. It
// opens on what the selection's first paragraph draws, and Apply writes only what changed. A negative indent is marked
// on its field, and Apply refuses it.
import { afterEach, expect, mock, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { expectFormContract, field, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { button, click, formats, message, paragraphs, value } from '../../fixtures/paragraph-dialog';

installHappyDom();

const { createElement, useState } = await import('react');
const { Editor } = await import('@tiptap/react');
const { DEFAULT_NORMAL_STYLE, getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { IndentationOptionsDialog } = await import('../../../components/docs/indentation-options-dialog');
const { keepEditorFocus } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

function Host() {
    const [open, setOpen] = useState(true);
    return createElement(IndentationOptionsDialog, {
        editor,
        normal: DEFAULT_NORMAL_STYLE,
        open,
        onOpenChange: setOpen,
        onCloseAutoFocus: keepEditorFocus(editor),
    });
}

function host(content: JSONContent) {
    editor.commands.setContent(content);
    editor.commands.setTextSelection(1);
    return createElement(Host);
}

async function open(content: JSONContent) {
    ({ unmount } = await renderInDocument(host(content)));
}

const pick = async (label: string, option: string) => {
    await click(field(label));
    await click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
};

// A change to the doc is what the dialog's submit reaches.
const written = mock(() => {});
editor.on('update', written);

test('Indentation options keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => host(paragraphs({})),
        submitLabel: 'Apply',
        firstField: 'Left',
        onSubmit: written,
        makeChanged: () => type('Right', '1'),
        makeInvalid: () => type('Right', '-1'),
        invalidField: 'Right',
        savesAtOnce: true,
    });
});

// Google's and Word's Left is where the body lines stand, and a hanging first line starts left of it.
test('Indentation options opens on no indent in centimeters, and Left with a hanging indent sets the body lines', async () => {
    await open(paragraphs({}));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Indentation options');
    expect(['Left', 'Right', 'Special indent'].map(value)).toEqual(['0', '0', 'None']);
    const by = field('By');
    expect(by instanceof HTMLInputElement && by.disabled).toBe(true);
    await type('Left', '2');
    await pick('Special indent', 'Hanging');
    await type('By', '1');
    await click(button('Apply'));
    // The body lines at 2 cm, the first line 1 cm left of them: w:left 1134 and w:hanging 567 in the docx.
    expect(await formats(editor)).toEqual([{ indentLeft: 56.7, indentFirstLine: -28.35 }]);
});

test('Indentation options shows a stored indent as Google does, and writes only what changed', async () => {
    await open(paragraphs({ indentLeft: 72, indentFirstLine: -36, indentRight: 18.05 }));
    expect(['Left', 'Right', 'Special indent', 'By'].map(value)).toEqual(['2.54', '0.64', 'Hanging', '1.27']);
    await type('By', '2.54');
    await click(button('Apply'));
    // Left stays where the body lines are, so only the first line moves.
    expect(await formats(editor)).toEqual([{ indentLeft: 72, indentFirstLine: -72, indentRight: 18.05 }]);
});

test('Indentation options: a first line indent, and None takes it away', async () => {
    await open(paragraphs({ indentFirstLine: 18 }));
    expect(['Special indent', 'By'].map(value)).toEqual(['First line', '0.64']);
    await pick('Special indent', 'None');
    await click(button('Apply'));
    expect(await formats(editor)).toEqual([{}]);
});

test('Indentation options refuses a negative indent, on the field that holds it', async () => {
    await open(paragraphs({}));
    await type('Left', '-1');
    expect(message()).toBe('Indents must be 0 cm or more.');
    expect(['Left', 'Right'].map((label) => field(label).getAttribute('aria-invalid'))).toEqual(['true', null]);
    await click(button('Apply'));
    expect(document.activeElement).toBe(field('Left'));
    expect(await formats(editor)).toEqual([{}]);
});
