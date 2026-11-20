// The Repeat select shows a saved rule as its preset when one matches, in the form the server hands the rule back,
// and any other rule as a sentence.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { RecurrencePicker } = await import('../../components/recurrence-picker');

// A Friday, so the weekly preset is "Weekly on Friday".
const FRIDAY = new Date(2026, 0, 2);

let unmount = async () => {};
afterEach(() => unmount());

async function triggerText(value: string | null) {
    const rendered = await renderInDocument(
        createElement(RecurrencePicker, { value, onChange: () => {}, startDate: FRIDAY, timezone: 'Europe/Amsterdam' }),
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
