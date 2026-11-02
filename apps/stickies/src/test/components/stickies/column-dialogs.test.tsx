// Add column asks for a title and hands it to the board. Column settings renames a column in the board's document, or
// deletes it with its cards after a confirmation. In both, Enter in Title submits as the submit button does, and a
// blank title submits nothing.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import * as Y from 'yjs';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { AddColumnDialog } = await import('../../../components/stickies/add-column-dialog');
const { ColumnSettingsDialog } = await import('../../../components/stickies/column-settings-dialog');

let unmount = async () => {};
afterEach(() => unmount());

const onClose = mock(() => {});

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
const button = (label: string) => footerButtons().find((b) => b.textContent === label);

async function openAddColumn() {
    onClose.mockClear();
    const onAddColumn = mock((_title: string) => {});
    ({ unmount } = await renderInDocument(createElement(AddColumnDialog, { isOpen: true, onClose, onAddColumn })));
    return onAddColumn;
}

test('Add column: Enter in Title adds the trimmed title and closes', async () => {
    const onAddColumn = await openAddColumn();
    await typeTitle('  Doing ');
    await enter();
    expect(onAddColumn.mock.calls).toEqual([['Doing']]);
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('Add column: a blank title keeps Add column off, and Enter adds nothing', async () => {
    const onAddColumn = await openAddColumn();
    await typeTitle('   ');
    expect(button('Add column')?.disabled).toBe(true);
    await enter();
    expect(onAddColumn).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
});

test('Add column starts empty again after a Cancel', async () => {
    let setOpen = (_open: boolean) => {};
    function Board() {
        const [open, setIsOpen] = useState(true);
        setOpen = setIsOpen;
        return createElement(AddColumnDialog, { isOpen: open, onClose: () => setIsOpen(false), onAddColumn() {} });
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
    onClose.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(ColumnSettingsDialog, {
            isOpen: true,
            onClose,
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
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('Column settings: a blank title keeps Save changes off, and Enter saves nothing', async () => {
    const doc = boardDoc();
    await openColumnSettings(doc);
    await typeTitle('  ');
    expect(button('Save changes')?.disabled).toBe(true);
    await enter();
    expect(columnTitle(doc)).toBe('To do');
    expect(onClose).not.toHaveBeenCalled();
});

test('Column settings: Delete column asks first, then removes the column and its card', async () => {
    const doc = boardDoc();
    await openColumnSettings(doc);
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Delete column', 'Cancel', 'Save changes']);
    await act(async () => button('Delete column')?.click());
    expect(doc.getMap('columns').has('c1')).toBe(true);
    const confirm = button('Delete');
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect(doc.getMap('columns').has('c1')).toBe(false);
    expect(doc.getMap('tasks').has('t1')).toBe(false);
    expect(doc.getArray('columnOrder').toArray()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
});
