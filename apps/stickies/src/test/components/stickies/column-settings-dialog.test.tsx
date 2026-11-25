// Column settings keeps the dialog contract, saves the trimmed title into the board's document, and deletes the column
// with its cards after a confirmation. A blank title says "Add a title" under the field. The board keeps the dialog
// mounted between openings, so each opening starts from the column's title, and the confirmation still names the
// column while it fades out after the delete. The save is one write to the document, so nothing is pending.
import { afterEach, expect, mock, test } from 'bun:test';
import { closingDialog, holdClosingDialogs } from '@workspace/ui/test/closing-dialog';
import { expectFormContract, field, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const { act, createElement, useEffect, useState } = await import('react');
const { ColumnSettingsDialog } = await import('../../../components/stickies/column-settings-dialog');

let unmount = async () => {};
afterEach(() => unmount());

// A board with one column, To do, holding one card.
function boardDoc() {
    const doc = new Y.Doc();
    doc.transact(() => {
        doc.getMap<unknown>('tasks').set('t1', new Y.Map());
        const column = new Y.Map<unknown>();
        column.set('title', 'To do');
        column.set('taskIds', Y.Array.from(['t1']));
        doc.getMap<unknown>('columns').set('c1', column);
        doc.getArray<string>('columnOrder').push(['c1']);
    });
    return doc;
}

const columnTitle = (doc: Y.Doc) => {
    const column = doc.getMap<unknown>('columns').get('c1');
    return column instanceof Y.Map ? column.get('title') : undefined;
};

let setOpen = (_open: boolean) => {};

// Column settings as the board holds it: mounted once opened, open or not, and reading the column from the document.
function Board({ doc }: { doc: Y.Doc }) {
    const [open, setIsOpen] = useState(true);
    setOpen = setIsOpen;
    const [, render] = useState(0);
    const column = doc.getMap<unknown>('columns').get('c1');
    const taskIds = column instanceof Y.Map ? column.get('taskIds') : undefined;
    useEffect(() => {
        const rerender = () => render((n) => n + 1);
        doc.on('update', rerender);
        return () => doc.off('update', rerender);
    }, [doc]);
    return createElement(ColumnSettingsDialog, {
        open,
        onOpenChange: setIsOpen,
        columnId: 'c1',
        columnTitle: columnTitle(doc) ?? '',
        cardCount: taskIds instanceof Y.Array ? taskIds.length : 0,
        yjsDoc: doc,
        undoManager: null,
    });
}

// Every open dialog's footer buttons: Column settings' and, above it, its confirmation's.
const footerButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-footer"] button'),
];
const button = (label: string) =>
    footerButtons().find((b) => (b.textContent || b.getAttribute('aria-label')) === label);

const DELETE_SENTENCE =
    'This will delete the column To do and 1 card within it. You can undo this straight after, until you close the board.';

test('Column settings keeps the dialog contract', async () => {
    // Each write to a fresh board's document is a save.
    const saved = mock((..._update: unknown[]) => {});
    await expectFormContract({
        kind: 'dialog',
        render: () => {
            const doc = boardDoc();
            doc.on('update', saved);
            return createElement(Board, { doc });
        },
        submitLabel: 'Save',
        firstField: 'Title',
        onSubmit: saved,
        makeChanged: () => type('Title', 'Doing'),
        makeInvalid: () => type('Title', '  '),
        invalidField: 'Title',
        savesAtOnce: true,
    });
});

test('Column settings saves the trimmed title into the column and closes', async () => {
    const doc = boardDoc();
    ({ unmount } = await renderInDocument(createElement(Board, { doc })));
    expect(field('Title')).toHaveProperty('value', 'To do');
    await type('Title', ' Done  ');
    await act(async () => button('Save')?.click());
    expect(columnTitle(doc)).toBe('Done');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Column settings: Delete column asks first, then removes the column and its card', async () => {
    const doc = boardDoc();
    ({ unmount } = await renderInDocument(createElement(Board, { doc })));
    expect(footerButtons().map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
        'Delete column',
        'Cancel',
        'Save',
    ]);
    expect(button('Delete column')?.dataset.variant).toBe('ghost');
    await act(async () => button('Delete column')?.click());
    expect(doc.getMap('columns').has('c1')).toBe(true);
    expect([...document.querySelectorAll('[role="dialog"] p')].map((p) => p.textContent)).toContain(DELETE_SENTENCE);
    const confirm = button('Delete');
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect(doc.getMap('columns').has('c1')).toBe(false);
    expect(doc.getMap('tasks').has('t1')).toBe(false);
    expect(doc.getArray('columnOrder').toArray()).toEqual([]);
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
});

test("Column settings starts from the column's title again after a Cancel", async () => {
    ({ unmount } = await renderInDocument(createElement(Board, { doc: boardDoc() })));
    await type('Title', 'Doing');
    await act(async () => button('Cancel')?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => setOpen(true));
    expect(field('Title')).toHaveProperty('value', 'To do');
});

test('the delete confirmation still names the column and its card while it fades out', async () => {
    const release = holdClosingDialogs();
    try {
        const doc = boardDoc();
        ({ unmount } = await renderInDocument(createElement(Board, { doc })));
        await act(async () => button('Delete column')?.click());
        await act(async () => button('Delete')?.click());
        expect(doc.getMap('columns').has('c1')).toBe(false);
        expect(
            [...document.querySelectorAll('[role="dialog"][data-state="closed"] p')].map((p) => p.textContent),
        ).toContain(DELETE_SENTENCE);
        expect(closingDialog()).not.toBeNull();
    } finally {
        release();
    }
});
