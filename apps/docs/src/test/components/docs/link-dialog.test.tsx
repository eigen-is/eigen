// The Docs link dialog has the sheet's fields and words. Selected text shows in a box it can't change and keeps its
// formatting; at a bare caret Display text is typed and inserted as the link. OK waits for an address a browser can
// open, as the sheet's does, and leaves the caret after the link. On a link the dialog edits that link whole, and
// every way out hands the focus back to the editor. A link's right-click rows open, copy, edit and remove it.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows, renderOpenMenu } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { withBrowserFrames } from '../../fixtures/browser-frames';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { MenuSections } = await import('@workspace/ui/components/context-menu');
const { LinkDialog, linkDialogTarget } = await import('../../../components/docs/link-dialog');
const { linkMenuSections } = await import('../../../components/docs/link-menu-sections');
const { keepEditorFocus } = await import('../../../components/docs/editor-toolbar');

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    await new Promise((resolve) => setTimeout(resolve));
});

// Mounted in the document, so a test can read whether it holds focus.
const editor = new Editor({
    element: document.body.appendChild(document.createElement('div')),
    extensions: getDocExtensions(),
});

const link = (href: string) => ({ type: 'link', attrs: { href } });
// "see " then "the docs" linked to eigen.is, its "the " bold.
const LINKED = {
    type: 'doc',
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'see ' },
                { type: 'text', text: 'the ', marks: [{ type: 'bold' }, link('https://eigen.is')] },
                { type: 'text', text: 'docs', marks: [link('https://eigen.is')] },
            ],
        },
    ],
};

beforeEach(() => {
    editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see the docs' }] }],
    });
    editor.commands.setTextSelection(1);
});

async function openDialog() {
    const target = linkDialogTarget(editor);
    function Host() {
        const [open, setOpen] = useState(true);
        return createElement(LinkDialog, {
            ...target,
            open,
            onOpenChange: setOpen,
            onCloseAutoFocus: keepEditorFocus(editor),
        });
    }
    ({ unmount } = await renderInDocument(createElement(Host)));
}

const field = (id: string) => {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no ${id} field`);
    return input;
};
const title = () => document.querySelector('[role="dialog"] h2')?.textContent;
const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label);
const refusal = () => document.querySelector('[role="dialog"] [data-slot="field-error"]')?.textContent ?? null;

async function type(id: string, value: string) {
    const input = field(id);
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error(`no ${label} button`);
    await withBrowserFrames(async () => {
        await act(async () => target.click());
    });
}

// The first paragraph's text runs, each with the href of each of its marks, a mark that is no link undefined.
const runs = () => {
    const found: [string | undefined, (string | undefined)[] | undefined][] = [];
    editor.state.doc.firstChild?.forEach((run) => {
        found.push([run.text, run.marks.length ? run.marks.map((mark) => mark.attrs['href']) : undefined]);
    });
    return found;
};

test('selected text shows in a box it cannot change, and OK waits for an address a browser can open', async () => {
    editor.commands.setTextSelection({ from: 5, to: 13 });
    await openDialog();
    expect(title()).toBe('Insert link');
    expect(field('link-text').value).toBe('the docs');
    expect(field('link-text').disabled).toBe(true);
    expect(document.activeElement).toBe(field('link-address'));
    expect(button('OK')?.disabled).toBe(true);
    expect(refusal()).toBeNull();

    await type('link-address', 'dashttps://example.com');
    expect(refusal()).toBe('Please enter a valid link');
    expect(button('OK')?.disabled).toBe(true);
    await type('link-address', 'javascript:alert(1)');
    expect(button('OK')?.disabled).toBe(true);

    // An address with no scheme opens as https, so it is stored that way.
    await type('link-address', ' eigen.is/help ');
    expect(refusal()).toBeNull();
    await click('OK');
    expect(runs()).toEqual([
        ['see ', undefined],
        ['the docs', ['https://eigen.is/help']],
    ]);
    // The next key types after the link instead of replacing it.
    expect([editor.state.selection.empty, editor.state.selection.from]).toEqual([true, 13]);
});

test('at a bare caret Display text goes in as the link, or the address when it is empty', async () => {
    editor.commands.setTextSelection(5);
    await openDialog();
    expect(field('link-text').disabled).toBe(false);
    await type('link-text', 'Eigen');
    await type('link-address', 'https://eigen.is');
    await click('OK');
    expect(runs()?.[1]).toEqual(['Eigen', ['https://eigen.is']]);

    editor.commands.setTextSelection(1);
    await openDialog();
    await type('link-address', 'mailto:hi@eigen.is');
    await click('OK');
    expect(runs()?.[0]).toEqual(['mailto:hi@eigen.is', ['mailto:hi@eigen.is']]);
});

test('on a link the dialog edits that link whole, and its formatting stays', async () => {
    editor.commands.setContent(LINKED);
    editor.commands.setTextSelection({ from: 10, to: 11 });
    await openDialog();
    // Nothing moves until OK.
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([10, 11]);
    expect(title()).toBe('Edit link');
    expect(field('link-text').value).toBe('the docs');
    expect(field('link-address').value).toBe('https://eigen.is');
    await type('link-address', 'https://eigen.is/docs');
    await click('OK');
    expect(runs()).toEqual([
        ['see ', undefined],
        ['the ', ['https://eigen.is/docs', undefined]],
        ['docs', ['https://eigen.is/docs']],
    ]);
    expect(editor.getJSON().content?.[0]?.content?.[1]?.marks).toContainEqual({ type: 'bold' });
});

test.each(['OK', 'Cancel'])('the dialog closed with %s gives focus back to the editor', async (label) => {
    editor.commands.setTextSelection({ from: 1, to: 4 });
    await openDialog();
    await type('link-address', 'https://eigen.is');
    await click(label);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement === editor.view.dom).toBe(true);
});

test('Cancel on a link leaves the caret where it was', async () => {
    editor.commands.setContent(LINKED);
    editor.commands.setTextSelection(10);
    await openDialog();
    expect(title()).toBe('Edit link');
    await click('Cancel');
    expect([editor.state.selection.empty, editor.state.selection.from]).toEqual([true, 10]);
});

async function openLinkMenu(href: string, onEdit = () => {}) {
    editor.commands.setContent(LINKED);
    editor.commands.setTextSelection(1);
    const rows = linkMenuSections(editor, { from: 5, to: 13, href }, onEdit);
    ({ unmount } = await renderOpenMenu(createElement(MenuSections, rows)));
}

async function clickRow(label: string) {
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
        (item) => item.textContent?.trim() === label,
    );
    if (!row) throw new Error(`no ${label} row`);
    await act(async () => row.click());
}

test('a link opens, copies, edits and removes from its right-click rows; one no browser can open has no Open', async () => {
    await openLinkMenu('https://eigen.is');
    expect(menuRows()).toEqual(['Open link', '—', 'Copy link', '—', 'Edit link', 'Remove link']);
    await unmount();

    await openLinkMenu('#_Toc1');
    expect(menuRows()).toEqual(['Copy link', '—', 'Edit link', 'Remove link']);
});

test('Edit link hands the link to the dialog, and Remove link unlinks it all', async () => {
    const onEdit = mock(() => {});
    await openLinkMenu('https://eigen.is', onEdit);
    await clickRow('Edit link');
    expect(onEdit).toHaveBeenCalledTimes(1);
    await unmount();

    await openLinkMenu('https://eigen.is');
    await clickRow('Remove link');
    expect(runs()).toEqual([
        ['see ', undefined],
        ['the ', [undefined]],
        ['docs', undefined],
    ]);
});
