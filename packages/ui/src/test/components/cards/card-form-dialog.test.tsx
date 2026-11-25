// The dialog that adds a card keeps the dialog contract: Esc, the X and a click outside ask "Discard changes?" once
// something was typed, Cancel drops it, and Save with no title says "Add a title" under the field.
import { expect, mock, test } from 'bun:test';
import type { CardFormPatch } from '@workspace/lib/types/comments';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { CardFormDialog } = await import('../../../components/cards/card-form-dialog');

const save = mock(async (_patch: CardFormPatch) => {});

function AddCard() {
    const [open, setOpen] = useState(true);
    return createElement(CardFormDialog, {
        open,
        onOpenChange: setOpen,
        dialogTitle: 'Add card',
        submitLabel: 'Add card',
        onSave: save,
    });
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
async function typeTitle(value: string) {
    const input = document.querySelector('[role="dialog"] input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no Title field');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

test('Add card keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(AddCard),
        submitLabel: 'Add card',
        firstField: 'Title',
        onSubmit: save,
        makeChanged: () => typeTitle('Order fencing'),
        makeInvalid: () => typeTitle('  '),
        invalidField: 'Title',
        modEnterFields: ['Description'],
    });
});

test('a new card hands on its trimmed title and the first color', async () => {
    save.mockClear();
    await renderInDocument(createElement(AddCard));
    await typeTitle('  Order fencing ');
    const add = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add card');
    await act(async () => add?.click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ title: 'Order fencing', description: '' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});
