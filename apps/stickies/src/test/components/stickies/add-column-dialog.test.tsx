// Add column keeps the dialog contract, hands the board its trimmed title, and starts empty at every opening. A blank
// title says "Add a title" under the field. The board writes the column into its document at once, so nothing is
// pending.
import { afterEach, expect, mock, test } from 'bun:test';
import { expectFormContract, field, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { AddColumnDialog } = await import('../../../components/stickies/add-column-dialog');

let unmount = async () => {};
afterEach(() => unmount());

const addColumn = mock((_title: string) => {});
let setOpen = (_open: boolean) => {};

function Board() {
    const [open, setIsOpen] = useState(true);
    setOpen = setIsOpen;
    return createElement(AddColumnDialog, { open, onOpenChange: setIsOpen, onAddColumn: addColumn });
}

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);

test('Add column keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Board),
        submitLabel: 'Add column',
        firstField: 'Title',
        onSubmit: addColumn,
        makeChanged: () => type('Title', 'Doing'),
        makeInvalid: () => type('Title', '   '),
        invalidField: 'Title',
        savesAtOnce: true,
    });
});

test('Add column hands on the trimmed title and closes', async () => {
    addColumn.mockClear();
    ({ unmount } = await renderInDocument(createElement(Board)));
    await type('Title', '  Doing ');
    await act(async () => button('Add column')?.click());
    expect(addColumn.mock.calls).toEqual([['Doing']]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Add column starts empty again after a Cancel', async () => {
    ({ unmount } = await renderInDocument(createElement(Board)));
    await type('Title', 'Doing');
    await act(async () => button('Cancel')?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => setOpen(true));
    expect(field('Title')).toHaveProperty('value', '');
});
