// The link field of the light editor's toolbar, inside a form such as the card form or Email collaborators. Enter in
// the field sets the link and leaves the form alone. Escape closes the field, and inside a dialog only the field: Radix
// hears Escape on the document before the field does. Opening the field in the floating toolbar places the toolbar
// again, and the focus does not scroll the dialog.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Dialog, DialogContent, DialogTitle } = await import('../../../components/dialog');
const { LightEditor } = await import('../../../components/editor/light-editor');

const onSubmit = mock((_event: unknown) => {});
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    onSubmit.mockClear();
    onOpenChange.mockClear();
});

async function open({ inDialog = false, toolbar = 'fixed' as 'fixed' | 'floating' } = {}) {
    const form = createElement(
        'form',
        {
            noValidate: true,
            onSubmit: (event: { preventDefault: () => void }) => {
                event.preventDefault();
                onSubmit(event);
            },
        },
        createElement(LightEditor, { content: '<p>Read this</p>', toolbar }),
    );
    ({ unmount } = await renderInDocument(
        inDialog
            ? createElement(
                  Dialog,
                  { open: true, onOpenChange },
                  createElement(DialogContent, null, createElement(DialogTitle, null, 'Card'), form),
              )
            : form,
    ));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const editor = (): Editor => {
    const editable: (HTMLElement & { editor?: Editor }) | null = document.querySelector('.ProseMirror');
    if (!editable?.editor) throw new Error('no editor');
    return editable.editor;
};
const linkField = () => document.querySelector<HTMLInputElement>('input[aria-label="Link URL"]');

async function openLinkField() {
    await act(async () => {
        editor().chain().focus().selectAll().run();
    });
    await act(async () => {
        document
            .querySelector('button[aria-label="Link"]')
            ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(linkField());
}

const type = (value: string) =>
    act(async () => {
        const field = linkField();
        if (!field) throw new Error('no link field');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });

// A browser's Enter in a text field submits its form unless the keydown is prevented.
const pressKey = (key: string) =>
    act(async () => {
        const field = linkField();
        if (!field) throw new Error('no link field');
        const form = field.form;
        const keydown = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        if (field.dispatchEvent(keydown) && key === 'Enter') form?.requestSubmit();
    });

test('Enter in the link field sets the link and does not submit the form around it', async () => {
    await open();
    await openLinkField();
    await type('example.com');
    await pressKey('Enter');
    expect(editor().getHTML()).toContain('href="https://example.com"');
    expect(linkField()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
});

test('Escape closes the link field and sets no link', async () => {
    await open();
    await openLinkField();
    await type('example.com');
    await pressKey('Escape');
    expect(linkField()).toBeNull();
    expect(editor().getHTML()).not.toContain('href');
});

test('Escape in the link field inside a dialog closes the field and leaves the dialog open', async () => {
    await open({ inDialog: true });
    await openLinkField();
    await type('example.com');
    await pressKey('Escape');
    expect(linkField()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Escape in the editor inside a dialog still closes the dialog', async () => {
    await open({ inDialog: true });
    await act(async () => {
        document
            .querySelector('.ProseMirror')
            ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('the floating toolbar places itself again for the link field, and the focus does not scroll the dialog', async () => {
    await open({ inDialog: true, toolbar: 'floating' });
    const focus = spyOn(HTMLInputElement.prototype, 'focus');
    try {
        // The menu shows a quarter second after the selection settles.
        await act(async () => {
            editor().chain().focus().selectAll().run();
        });
        await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
        // The menu as it was placed when it showed, moved off so a new placement shows.
        const menu = document.querySelector('button[aria-label="Link"]')?.closest<HTMLElement>('[style*="position"]');
        if (!menu) throw new Error('the floating toolbar did not show');
        menu.style.left = '999px';

        await openLinkField();
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(menu.style.left).not.toBe('999px');
        expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    } finally {
        focus.mockRestore();
    }
});
