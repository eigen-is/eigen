// The retention dialog, making a bucket safe and changing its retention, keeps the dialog contract. A number of days the
// rule can't take, such as 0, 7.5 or more than the maximum, is refused under the field and nothing is sent.
import { expect, mock, test } from 'bun:test';
import { S3_NONCURRENT_DAYS_MAX } from '@workspace/lib/constants/s3';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { RetentionDialog } = await import('../../../components/mount/bucket-safety');

const harden = mock(async (_days: number) => {});

function Retention({ changingRetention = false }: { changingRetention?: boolean }) {
    const [open, setOpen] = useState(true);
    return createElement(RetentionDialog, {
        open,
        onOpenChange: setOpen,
        changingRetention,
        initialDays: 30,
        onSubmit: harden,
    });
}

const daysField = () => {
    const found = document.querySelector('[role="dialog"] input[type="number"]');
    if (!(found instanceof HTMLInputElement)) throw new Error('no days field');
    return found;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeDays = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(daysField(), value);
        daysField().dispatchEvent(new Event('input', { bubbles: true }));
    });

for (const [title, changingRetention, submitLabel] of [
    ['Make this bucket safe', false, 'Enable'],
    ['Change retention', true, 'Save'],
] as const) {
    test(`${title} keeps the dialog contract`, async () => {
        await expectFormContract({
            kind: 'dialog',
            render: () => createElement(Retention, { changingRetention }),
            submitLabel,
            firstField: 'Expire old versions after days',
            onSubmit: harden,
            makeChanged: () => typeDays('60'),
            makeInvalid: () => typeDays('0'),
            invalidField: 'Expire old versions after days',
        });
    });
}

test('the dialog opens on the days field', async () => {
    const { unmount } = await renderInDocument(createElement(Retention));
    expect(document.activeElement).toBe(daysField());
    await unmount();
});

test('days the rule cannot take are refused under the field, and whole days in range are sent', async () => {
    harden.mockClear();
    const { unmount } = await renderInDocument(createElement(Retention));
    const enable = () =>
        act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Enable')?.click());
    for (const days of ['', '0', '7.5', String(S3_NONCURRENT_DAYS_MAX + 1)]) {
        await typeDays(days);
        await enable();
        expect(daysField().getAttribute('aria-invalid')).toBe('true');
    }
    expect(harden).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe(
        'Use a whole number of days from 1 to 3,650',
    );
    await typeDays(String(S3_NONCURRENT_DAYS_MAX));
    await enable();
    expect(harden.mock.calls).toEqual([[S3_NONCURRENT_DAYS_MAX]]);
    await unmount();
});
