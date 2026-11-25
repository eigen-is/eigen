// Join the waitlist keeps the page contract: the email has the focus, Enter and Cmd+Enter join once, an address that
// is none says so under the field instead of a browser bubble, the button shows that it is busy, and leaving with a
// typed address asks. A join sends the trimmed address with the note and closes the card.
import { afterAll, expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const join = mock(async (_entry: { email: string; notes: string }) => ({}));
// One object, so the effects that depend on it settle.
const joinWaitlist = { mutateAsync: join, isPending: false };
// A copy, because mock.module rewrites a loaded module's exports in place, and afterAll puts the original back.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({ ...realPublic, useJoinWaitlist: () => joinWaitlist }));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { WaitlistForm } = await import('../../components/waitlist-form');

const close = mock(() => {});

function field(label: string): HTMLInputElement {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
}

// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field('Email'), value);
        field('Email').dispatchEvent(new Event('input', { bubbles: true }));
    });

test('Join the waitlist keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(WaitlistForm, { onClose: close }),
        submitLabel: 'Join waitlist',
        firstField: 'Email',
        onSubmit: join,
        makeChanged: () => type('ada@example.com'),
        makeInvalid: () => type('ada at example'),
        invalidField: 'Email',
    });
});

test('a join sends the trimmed address with the note and closes the card', async () => {
    join.mockClear();
    close.mockClear();
    const root = router.createRootRoute({ component: () => createElement(WaitlistForm, { onClose: close }) });
    const memory = router.createRouter({ routeTree: root, history: router.createMemoryHistory() });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    await type(' ada@example.com ');
    await act(async () => pressEnter(field('Email')));
    expect(join.mock.calls).toEqual([[{ email: 'ada@example.com', notes: '' }]]);
    expect(close).toHaveBeenCalledTimes(1);
});
