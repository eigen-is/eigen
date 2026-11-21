// Add column asks for a title and hands it to the board. Column settings renames a column in the board's document, or
// deletes it with its cards after a confirmation. In both, Enter in Title submits as the submit button does, and a
// blank title submits nothing. Column settings stays mounted between openings, as the board keeps it, so each opening
// starts from the column's title, and the confirmation still names the column while it fades out after the delete.
import { afterEach, expect, mock, test } from 'bun:test';
import { closingDialog, holdClosingDialogs } from '@workspace/ui/test/closing-dialog';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const { act, createElement, useEffect, useState } = await import('react');
const { AddColumnDialog } = await import('../../../components/stickies/add-column-dialog');
const { ColumnSettingsDialog } = await import('../../../components/stickies/column-settings-dialog');

let unmount = async () => {};
afterEach(() => unmount());

const onOpenChange = mock((_open: boolean) => {});

const titleField = () => {
    const field = document.getElementById(
        [...document.querySelectorAll('label')].find((l) => l.textContent === 'Title')?.htmlFor ?? '',
    );
    if (!(field instanceof HTMLInputElement)) throw new Error('no Title field');
    return field;
};

async function typeTitle(text: string) {
    const field = titleField();
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text);
    await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })));
}

const enter = () => act(async () => pressEnter(titleField()));

// Every open dialog's footer buttons: Column settings' and, above it, its confirmation's.
const footerButtons = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-footer"] button'),
];
const button = (label: string) =>
    footerButtons().find((b) => (b.textContent || b.getAttribute('aria-label')) === label);

async function openAddColumn() {
    onOpenChange.mockClear();
    const onAddColumn = mock((_title: string) => {});
    ({ unmount } = await renderInDocument(createElement(AddColumnDialog, { open: true, onOpenChange, onAddColumn })));
    return onAddColumn;
}

test('Add column: Enter in Title adds the trimmed title and closes', async () => {
    const onAddColumn = await openAddColumn();
    await typeTitle('  Doing ');
    await enter();
    expect(onAddColumn.mock.calls).toEqual([['Doing']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Add column: a blank title keeps Add column off, and Enter adds nothing', async () => {
    const onAddColumn = await openAddColumn();
    await typeTitle('   ');
    expect(button('Add column')?.disabled).toBe(true);
    await enter();
    expect(onAddColumn).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Add column starts empty again after a Cancel', async () => {
    let setOpen = (_open: boolean) => {};
    function Board() {
        const [open, setIsOpen] = useState(true);
        setOpen = setIsOpen;
        return createElement(AddColumnDialog, { open, onOpenChange: setIsOpen, onAddColumn() {} });
    }
    ({ unmount } = await renderInDocument(createElement(Board)));
    await typeTitle('Doing');
    await act(async () => button('Cancel')?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => setOpen(true));
    expect(titleField().value).toBe('');
});

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

async function openColumnSettings(doc: Y.Doc) {
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(ColumnSettingsDialog, {
            open: true,
            onOpenChange,
            columnId: 'c1',
            columnTitle: 'To do',
            cardCount: 1,
            yjsDoc: doc,
            undoManager: null,
        }),
    ));
}

const columnTitle = (doc: Y.Doc) => {
    const column = doc.getMap<unknown>('columns').get('c1');
    return column instanceof Y.Map ? column.get('title') : undefined;
};

test('Column settings: Enter in Title saves the trimmed title into the column and closes', async () => {
    const doc = boardDoc();
    await openColumnSettings(doc);
    expect(titleField().value).toBe('To do');
    await typeTitle(' Done  ');
    await enter();
    expect(columnTitle(doc)).toBe('Done');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Column settings: a blank title keeps Save changes off, and Enter saves nothing', async () => {
    const doc = boardDoc();
    await openColumnSettings(doc);
    await typeTitle('  ');
    expect(button('Save changes')?.disabled).toBe(true);
    await enter();
    expect(columnTitle(doc)).toBe('To do');
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Column settings: Delete column asks first, then removes the column and its card', async () => {
    const doc = boardDoc();
    await openColumnSettings(doc);
    expect(footerButtons().map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
        'Delete column',
        'Cancel',
        'Save changes',
    ]);
    expect(button('Delete column')?.dataset.variant).toBe('ghost');
    await act(async () => button('Delete column')?.click());
    expect(doc.getMap('columns').has('c1')).toBe(true);
    expect([...document.querySelectorAll('[role="dialog"] p')].map((p) => p.textContent)).toContain(
        'This will delete the column To do and 1 card within it. You can undo this straight after, until you close the board.',
    );
    const confirm = button('Delete');
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect(doc.getMap('columns').has('c1')).toBe(false);
    expect(doc.getMap('tasks').has('t1')).toBe(false);
    expect(doc.getArray('columnOrder').toArray()).toEqual([]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
});

// Column settings as the board holds it: mounted once opened, open or not, and reading the column from the document.
async function renderBoardColumnSettings(doc: Y.Doc) {
    let setOpen = (_open: boolean) => {};
    function Board() {
        const [open, setIsOpen] = useState(true);
        setOpen = setIsOpen;
        const [, render] = useState(0);
        const column = doc.getMap<unknown>('columns').get('c1');
        const taskIds = column instanceof Y.Map ? column.get('taskIds') : undefined;
        useEffect(() => {
            const rerender = () => render((n) => n + 1);
            doc.on('update', rerender);
            return () => doc.off('update', rerender);
        }, []);
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
    ({ unmount } = await renderInDocument(createElement(Board)));
    return (open: boolean) => act(async () => setOpen(open));
}

test("Column settings starts from the column's title again after a Cancel", async () => {
    const setOpen = await renderBoardColumnSettings(boardDoc());
    await typeTitle('Doing');
    await act(async () => button('Cancel')?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await setOpen(true);
    expect(titleField().value).toBe('To do');
});

test('the delete confirmation still names the column and its card while it fades out', async () => {
    const release = holdClosingDialogs();
    try {
        const doc = boardDoc();
        await renderBoardColumnSettings(doc);
        await act(async () => button('Delete column')?.click());
        await act(async () => button('Delete')?.click());
        expect(doc.getMap('columns').has('c1')).toBe(false);
        expect(
            [...document.querySelectorAll('[role="dialog"][data-state="closed"] p')].map((p) => p.textContent),
        ).toContain(
            'This will delete the column To do and 1 card within it. You can undo this straight after, until you close the board.',
        );
        expect(closingDialog()).not.toBeNull();
    } finally {
        release();
    }
});
