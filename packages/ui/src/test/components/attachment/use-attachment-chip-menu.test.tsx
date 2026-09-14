import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement, Fragment } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SimpleAttachmentChip } = await import('../../../components/attachment/simple-attachment-chip');
const { useAttachmentChipMenu } = await import('../../../components/attachment/use-attachment-chip-menu');

// The menu item is the chip key itself: what the wrapper owes a host is which chip the press landed
// on, and nothing when the press landed on no chip.
function Host({ onItem, onSave }: { onItem: (item: string | null) => void; onSave: () => void }) {
    const { contextMenu, bind } = useAttachmentChipMenu<string>((chipKey) => chipKey ?? undefined);
    onItem(contextMenu.item);
    return createElement(
        'div',
        bind(),
        createElement(SimpleAttachmentChip, {
            key: 'one',
            attachmentKey: 'part-0',
            filename: 'invoice.pdf',
            downloadUrl: 'https://example.test/part-0',
        }),
        createElement('a', { id: 'other-link', href: 'https://example.test/elsewhere' }, 'a link'),
        createElement('span', { id: 'body' }, 'message text'),
        createElement('button', { id: 'save-all', type: 'button', onClick: onSave }, 'Save attachments'),
    );
}

async function mountHost() {
    const items: (string | null)[] = [];
    const saves: number[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                Fragment,
                null,
                createElement(Host, { onItem: (item) => items.push(item), onSave: () => saves.push(1) }),
            ),
        );
    });
    const at = (selector: string) => {
        const element = container.querySelector(selector);
        if (!element) throw new Error(`no ${selector}`);
        return element;
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { items, saves, at, cleanup, last: () => items[items.length - 1] };
}

async function longPress(element: Element) {
    await act(async () => {
        const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 });
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        element.dispatchEvent(down);
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
    });
}

async function click(element: Element) {
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

async function rightClick(element: Element) {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
        element.dispatchEvent(event);
    });
    return event;
}

test('a right-click on a chip opens the menu for that chip', async () => {
    const host = await mountHost();
    const event = await rightClick(host.at('[data-attachment-chip="part-0"] span'));
    expect(host.last()).toBe('part-0');
    expect(event.defaultPrevented).toBe(true);
    await host.cleanup();
});

test('a right-click on a link that is not a chip is left to the browser', async () => {
    const host = await mountHost();
    const event = await rightClick(host.at('#other-link'));
    expect(host.last()).toBe(null);
    // The browser's own copy-link menu is what should appear, so the event must survive untouched.
    expect(event.defaultPrevented).toBe(false);
    await host.cleanup();
});

test('a right-click on the row itself opens whatever the host builds without a chip', async () => {
    const host = await mountHost();
    await rightClick(host.at('#body'));
    expect(host.last()).toBe(null);
    await host.cleanup();
});

test('a touch long-press on a chip opens the same menu', async () => {
    const host = await mountHost();
    const chip = host.at('[data-attachment-chip="part-0"] span');
    await act(async () => {
        const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 60 });
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        chip.dispatchEvent(down);
    });
    expect(host.last()).toBe(null);
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(host.last()).toBe('part-0');
    await host.cleanup();
});

test('a long press that opens no menu leaves the click that follows alone', async () => {
    const host = await mountHost();
    const button = host.at('#save-all');
    await longPress(button);
    expect(host.last()).toBe(null);
    await click(button);
    expect(host.saves.length).toBe(1);
    await host.cleanup();
});

test('a long press that opened a menu still swallows the click that follows', async () => {
    const host = await mountHost();
    await longPress(host.at('[data-attachment-chip="part-0"] span'));
    expect(host.last()).toBe('part-0');
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
        host.at('[data-attachment-chip="part-0"] span').dispatchEvent(click2);
    });
    expect(click2.defaultPrevented).toBe(true);
    await host.cleanup();
});
