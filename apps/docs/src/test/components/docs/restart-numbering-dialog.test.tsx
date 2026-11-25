// Google Docs' Restart numbering: the number a numbered list starts at, from the item the caret is in. It opens on 1,
// selected so a typed number replaces it, and Apply restarts the list there. A number below 1 or with a fraction is
// marked on the field, and Apply refuses it.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { expectFormContract, field, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { button, click, message } from '../../fixtures/paragraph-dialog';

installHappyDom();

const { createElement, useState } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { RestartNumberingDialog } = await import('../../../components/docs/restart-numbering-dialog');
const { keepEditorFocus } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

const item = (text: string) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function Host() {
    const [open, setOpen] = useState(true);
    return createElement(RestartNumberingDialog, {
        editor,
        open,
        onOpenChange: setOpen,
        onCloseAutoFocus: keepEditorFocus(editor),
    });
}

// The caret in the list's first item.
function host() {
    editor.commands.setContent({ type: 'doc', content: [{ type: 'orderedList', content: [item('ab'), item('cd')] }] });
    editor.commands.setTextSelection(3);
    return createElement(Host);
}

const start = () => editor.state.doc.firstChild?.attrs['start'];

// A change to the doc is what the dialog's submit reaches.
const written = mock(() => {});
editor.on('update', written);

test('Restart numbering keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: host,
        submitLabel: 'Apply',
        firstField: 'Start at',
        onSubmit: written,
        makeChanged: () => type('Start at', '3'),
        makeInvalid: () => type('Start at', '0'),
        invalidField: 'Start at',
        savesAtOnce: true,
        except: { focus: 'a number field reads no selection in the DOM, so the next test checks the select itself' },
    });
});

test('Start at has the focus as it opens, its 1 selected so a typed number replaces it', async () => {
    const select = spyOn(HTMLInputElement.prototype, 'select');
    try {
        ({ unmount } = await renderInDocument(host()));
        expect(document.activeElement).toBe(field('Start at'));
        expect(select.mock.contexts.at(-1)).toBe(field('Start at'));
    } finally {
        select.mockRestore();
    }
});

test('Apply restarts the list at the number typed', async () => {
    ({ unmount } = await renderInDocument(host()));
    await type('Start at', '5');
    await click(button('Apply'));
    expect(start()).toBe(5);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test.each(['0', '1.5', ''])('%p shows a message and Apply does nothing', async (typed) => {
    ({ unmount } = await renderInDocument(host()));
    await type('Start at', typed);
    await click(button('Apply'));
    expect(message()).toBe('Start at a whole number of 1 or more.');
    expect(field('Start at').getAttribute('aria-invalid')).toBe('true');
    expect(start()).toBe(1);
});
