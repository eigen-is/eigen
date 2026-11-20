// The Repeat select shows a saved rule as its preset when one matches, in the form the server hands the rule back,
// and any other rule as a sentence.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { RecurrencePicker } = await import('../../components/recurrence-picker');

// A Friday, so the weekly preset is "Weekly on Friday".
const FRIDAY = new Date(2026, 0, 2);
// The fifth Friday of its month, which Google Calendar repeats on the last Friday.
const FIFTH_FRIDAY = new Date(2026, 0, 30);

let unmount = async () => {};
afterEach(() => unmount());

async function triggerText(value: string | null, startDate = FRIDAY, onChange = (_rrule: string | null) => {}) {
    const rendered = await renderInDocument(
        createElement(RecurrencePicker, { value, onChange, startDate, timezone: 'Europe/Amsterdam' }),
    );
    unmount = rendered.unmount;
    return rendered.container.querySelector('[data-slot="select-trigger"]')?.textContent;
}

test('a saved weekly rule, as the server returns it, shows its preset', async () => {
    expect(await triggerText('FREQ=WEEKLY;BYDAY=FR')).toBe('Weekly on Friday');
});

test('a rule no preset matches reads as a sentence', async () => {
    expect(await triggerText('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('Custom: Every 2 weeks on Friday');
});

// Radix opens its Select and picks an option on the pointer events, not on click.
const pointAt = (element: Element) =>
    act(async () => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

test('a start in the fifth week repeats monthly on the last weekday', async () => {
    const picked: (string | null)[] = [];
    await triggerText(null, FIFTH_FRIDAY, (rrule) => picked.push(rrule));
    const trigger = document.querySelector('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('the picker has no trigger');
    await pointAt(trigger);
    const option = [...document.querySelectorAll('[role="option"]')].find(
        (o) => o.textContent === 'Monthly on the last Friday',
    );
    if (!option) throw new Error('the picker offers no monthly preset on the last Friday');
    await pointAt(option);
    expect(picked).toEqual(['FREQ=MONTHLY;BYDAY=-1FR']);
});

test('a saved last-weekday rule shows its preset', async () => {
    expect(await triggerText('FREQ=MONTHLY;BYDAY=-1FR', FIFTH_FRIDAY)).toBe('Monthly on the last Friday');
});
