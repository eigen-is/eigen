import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ColorRow } = await import('../../../components/properties-panel/color-row');

// Mounts a row, clicks its trigger, and reads back every label the open popover shows.
async function openPopover(props: { value: string; allowNone?: boolean; noneLabel?: string }) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(ColorRow, { label: 'Color', onChange: () => {}, ...props }));
    });

    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('color row did not render its trigger');
    await act(async () => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const labels = [...document.querySelectorAll('span')].map((el) => el.textContent?.trim() ?? '');
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { labels, cleanup };
}

// A picked colour is replaced by picking another one, and where paint is optional None is the way back
// — so a Reset row was a third way to say what the popover already says. It is gone from every row.
test('the popover never offers a Reset row', async () => {
    const withNone = await openPopover({ value: '#ff0000', allowNone: true });
    expect(withNone.labels).not.toContain('Reset');
    await withNone.cleanup();

    const withoutNone = await openPopover({ value: '#ff0000' });
    expect(withoutNone.labels).not.toContain('Reset');
    await withoutNone.cleanup();
});

// None stays opt-in: an arrow IS its stroke, so its colour row must not offer a way to erase it.
test('the None row shows only where the caller allows it', async () => {
    const optional = await openPopover({ value: '#ff0000', allowNone: true });
    expect(optional.labels).toContain('None');
    await optional.cleanup();

    const required = await openPopover({ value: '#ff0000' });
    expect(required.labels).not.toContain('None');
    await required.cleanup();
});

// The label is the caller's word for "no paint" — a gradient stop calls it Transparent.
test('allowNone renders the caller label', async () => {
    const { labels, cleanup } = await openPopover({
        value: '#ff0000',
        allowNone: true,
        noneLabel: 'Transparent',
    });
    expect(labels).toContain('Transparent');
    await cleanup();
});
