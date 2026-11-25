// Leaving a card's edit for a view whose bar has no Edit action leaves the focus on the dialog, not on the page behind it.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { CardDialogFrame } = await import('../../../components/cards/card-dialog-frame');

let leave = () => {};

function Frame() {
    const [editing, setEditing] = useState(true);
    leave = () => setEditing(false);
    return createElement(CardDialogFrame, {
        open: true,
        onOpenChange: () => {},
        title: 'Audit card',
        editing: editing ? { changed: false, pending: false, onCancel: leave } : undefined,
        children: editing ? createElement('input', { 'aria-label': 'Title', autoFocus: true }) : 'Audit card',
    });
}

test('leaving the edit with no Edit action in the bar focuses the dialog', async () => {
    await renderInDocument(createElement(Frame));
    await act(async () => leave());
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
});
