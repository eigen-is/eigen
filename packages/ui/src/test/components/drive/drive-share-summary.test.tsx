// The share summary in a Drive row and the chat toolbar shows who has access. Where a click opens Share, it is a button
// the keyboard reaches, and its click stays off the row. In a Drive row Tab skips it, since the row's menu key reaches
// Share. Elsewhere it is no control at all. On an item nobody else
// has, its add-person icon shows to a mouse user on hover only, and when Tab reaches the button. The lock on a shared
// link says who the link lets in, in the Share dialog's words.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { DirectAccessItem } from '@workspace/lib/types/drive-access';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { pressKey } from '../../press-key';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);

const OWNER: DirectAccessItem = { id: 'owner@example.com', read: true, write: true, owner: true };
const ADA: DirectAccessItem = { id: 'ada@example.com', read: true, write: true, owner: false };
let entries: DirectAccessItem[] = [];

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useDriveAccess: () => ({ allEntries: entries }),
}));
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email }: { email?: string }) => ({
        displayName: email ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
afterAll(() => {
    fetchSpy.mockRestore();
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const { DriveShareSummary } = await import('../../../components/drive/drive-share-summary');

const notes = drivePath({ id: 'notes', name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC });
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    entries = [OWNER, ADA];
});

// The summary inside a row's cell that listens for clicks and is the hover group, as a Drive row's Shared cell is.
async function renderSummary(props: {
    onClick?: () => void;
    showIconOnHover?: boolean;
    visibility?: 'private' | 'public-read';
    tabIndex?: number;
}) {
    const onRowClick = mock(() => {});
    const path = { ...notes, visibility: props.visibility ?? 'private' };
    const rendered = await renderInDocument(
        createElement(
            'div',
            { className: 'group', onClick: onRowClick },
            createElement(DriveShareSummary, {
                path,
                onClick: props.onClick,
                showIconOnHover: props.showIconOnHover,
                tabIndex: props.tabIndex,
            }),
        ),
    );
    unmount = rendered.unmount;
    return { container: rendered.container, onRowClick };
}

test('a summary that opens Share is a button the keyboard reaches, and its click stays off the row', async () => {
    const onClick = mock(() => {});
    const { container, onRowClick } = await renderSummary({ onClick });
    const button = container.querySelector('button');
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Share');
    expect(button?.tabIndex).toBe(0);
    if (!button) return;
    await act(async () => pressKey(button, 'Enter'));
    await act(async () => pressKey(button, ' '));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).not.toHaveBeenCalled();
});

test('taken out of the Tab order, as in a Drive row, the button still opens Share on a click', async () => {
    const onClick = mock(() => {});
    const { container, onRowClick } = await renderSummary({ onClick, tabIndex: -1 });
    const button = container.querySelector('button');
    expect(button?.tabIndex).toBe(-1);
    await act(async () => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
});

test('a summary with nothing to open is no control', async () => {
    const { container } = await renderSummary({});
    expect(container.querySelector('button')).toBeNull();
    // The two people, each an avatar with a tooltip.
    expect(container.querySelectorAll('[data-slot="tooltip-trigger"]')).toHaveLength(2);
});

test('a summary that shows nothing is no button, so Tab does not stop on an empty spot', async () => {
    entries = [OWNER];
    const { container } = await renderSummary({ onClick: () => {}, showIconOnHover: false });
    expect(container.querySelector('button')).toBeNull();
});

test('on an item nobody else has, the add-person icon shows on hover only, and when Tab reaches the button', async () => {
    entries = [OWNER];
    const { container } = await renderSummary({ onClick: () => {} });
    const icon = container.querySelector('button svg');
    if (!icon) throw new Error('the summary drew no add-person button');
    expectKeyboardReveal(icon);
});

test('the lock on a shared link says who the link lets in, as the Share dialog does', async () => {
    const { container } = await renderSummary({ visibility: 'public-read' });
    // The lock comes before the people.
    const lock = container.querySelector('[data-slot="tooltip-trigger"]');
    await act(async () => {
        lock?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Anyone signed in with the link');
});
