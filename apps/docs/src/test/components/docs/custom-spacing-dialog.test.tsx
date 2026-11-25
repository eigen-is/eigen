// Google Docs' Custom spacing: the line spacing, and the space before and after in points. It opens on what the
// selection's first paragraph draws, and Apply writes only the fields that changed, to every paragraph selected. A value
// out of range is marked on its field, and Apply refuses it.
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
const { CustomSpacingDialog } = await import('../../../components/docs/custom-spacing-dialog');
const { keepEditorFocus } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

function Host({ normal }: { normal: typeof DEFAULT_NORMAL_STYLE }) {
    const [open, setOpen] = useState(true);
    return createElement(CustomSpacingDialog, {
        editor,
        normal,
        open,
        onOpenChange: setOpen,
        onCloseAutoFocus: keepEditorFocus(editor),
    });
}

function host(content: JSONContent, from = 1, to = from, normal = DEFAULT_NORMAL_STYLE) {
    editor.commands.setContent(content);
    editor.commands.setTextSelection({ from, to });
    return createElement(Host, { normal });
}

async function open(...args: Parameters<typeof host>) {
    ({ unmount } = await renderInDocument(host(...args)));
}

// A change to the doc is what the dialog's submit reaches.
const written = mock(() => {});
editor.on('update', written);

test('Custom spacing keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => host(paragraphs({})),
        submitLabel: 'Apply',
        firstField: 'Line spacing',
        onSubmit: written,
        makeChanged: () => type('Before', '6'),
        makeInvalid: () => type('After', '-1'),
        invalidField: 'After',
        savesAtOnce: true,
    });
});

test("Custom spacing opens on Eigen's look for an unset paragraph, and an untouched field writes nothing", async () => {
    await open(paragraphs({}));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Custom spacing');
    expect(['Line spacing', 'Before', 'After'].map(value)).toEqual(['1.4', '0', '11']);
    await type('Before', '6');
    await click(button('Apply'));
    expect(await formats(editor)).toEqual([{ spaceBefore: 6 }]);
});

test("Custom spacing opens on the doc's Normal for an unset paragraph", async () => {
    await open(paragraphs({}), 1, 1, { ...DEFAULT_NORMAL_STYLE, lineSpacing: 1.15, spaceBefore: 3, spaceAfter: 10 });
    expect(['Line spacing', 'Before', 'After'].map(value)).toEqual(['1.15', '3', '10']);
});

test('Custom spacing writes every selected paragraph, from what the first one draws', async () => {
    await open(paragraphs({ lineSpacing: 1.15, spaceAfter: 4 }, {}), 1, 6);
    expect(['Line spacing', 'Before', 'After'].map(value)).toEqual(['1.15', '0', '4']);
    await type('Line spacing', '2');
    await click(button('Apply'));
    expect(await formats(editor)).toEqual([{ lineSpacing: 2, spaceAfter: 4 }, { lineSpacing: 2 }]);
});

// A list, a quote and a table cell own the spacing of what they hold.
test("in a list item Custom spacing sets the line spacing, and Before and After are the list's", async () => {
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'ab' }] };
    await open(
        { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }] },
        3,
    );
    expect(['Before', 'After'].map((label) => field(label).hasAttribute('disabled'))).toEqual([true, true]);
    expect(['Before', 'After'].map(value)).toEqual(['0', '0']);
    await type('Line spacing', '2');
    await click(button('Apply'));
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs).toMatchObject({
        lineSpacing: 2,
        spaceBefore: null,
        spaceAfter: null,
    });
});

test('Custom spacing refuses a line spacing or a spacing out of range, on the field that holds it', async () => {
    await open(paragraphs({}));
    await type('Line spacing', '9');
    expect(message()).toBe('Line spacing must be between 0.5 and 5, and spacing between 0 and 400 points.');
    expect(field('Line spacing').getAttribute('aria-invalid')).toBe('true');
    await type('Line spacing', '1.5');
    await type('After', '-1');
    expect(['Line spacing', 'After'].map((label) => field(label).getAttribute('aria-invalid'))).toEqual([null, 'true']);
    await type('After', '');
    await click(button('Apply'));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(await formats(editor)).toEqual([{}]);
});
