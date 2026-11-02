// A long list of people starts collapsed under a header button the keyboard reaches: Enter, Space and a click open
// and close it. The header's own actions, such as Copy emails, still work and leave the list as it was.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { pressKey } from '../../press-key';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { ClipboardCopy } = await import('lucide-react');
const { TooltipButton } = await import('../../../components/layout/toolbar/tooltip-button');
const { CollapsibleUserList } = await import('../../../components/user/collapsible-user-list');

let unmount = async () => {};
afterEach(() => unmount());

const copy = mock(() => {});
const guests = ['ada', 'bob', 'carol', 'dan', 'erin'];

async function render(count: number) {
    copy.mockClear();
    ({ unmount } = await renderInDocument(
        createElement(CollapsibleUserList, {
            title: `${count} guests`,
            summaryLines: ['2 accepted'],
            count,
            actions: createElement(TooltipButton, { icon: ClipboardCopy, tooltipText: 'Copy emails', onClick: copy }),
            children: guests.slice(0, count).map((name) => createElement('p', { key: name }, name)),
        }),
    ));
}

const header = () => {
    const found = document.querySelector('button[aria-expanded]');
    if (!found) throw new Error('the list has no header button');
    return found;
};
const expanded = () => header().getAttribute('aria-expanded');
const copyButton = () => {
    const found = document.querySelector('button[aria-label="Copy emails"]');
    if (!found) throw new Error('the header has no Copy emails button');
    return found;
};

test('the header is a button named by the title, which Enter, Space and a click toggle', async () => {
    await render(5);
    expect(header().textContent).toBe('5 guests');
    expect(expanded()).toBe('false');
    await act(async () => pressKey(header(), 'Enter'));
    expect(expanded()).toBe('true');
    expect(document.body.textContent).toContain('erin');
    await act(async () => pressKey(header(), ' '));
    expect(expanded()).toBe('false');
    await act(async () => {
        header().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(expanded()).toBe('true');
});

test('the header action works and leaves the list as it was', async () => {
    await render(5);
    await act(async () => {
        copyButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => pressKey(copyButton(), 'Enter'));
    expect(copy).toHaveBeenCalledTimes(2);
    expect(expanded()).toBe('false');
    // Not inside the header button, which would make it a button in a button.
    expect(header().contains(copyButton())).toBe(false);
});

test('a short list shows everyone under a plain header', async () => {
    await render(3);
    expect(document.querySelector('button[aria-expanded]')).toBeNull();
    expect(document.body.textContent).toContain('carol');
    expect(copyButton()).not.toBeNull();
});
