// A comment's card floating at the rect a host reports: drawn as a board draws it, leaving the editor's focus alone,
// and telling the host when the pointer is on it, when it is clicked and when Radix wants it closed.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard, CommentHoverTarget } from '@workspace/lib/types/comments';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useMediaResolver: () => ({ resolveMediaPath: () => undefined }),
}));
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'me@example.com' } }) }));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement, useState } = await import('react');
const { CommentHoverCard } = await import('../../../components/comments');

const cards: Record<string, CommentCard> = {
    a: { id: 'a', title: 'The title', description: '<p>The description</p>', chatName: 'thread-a.eigenchat' },
    b: { id: 'b', title: '', description: '<p>Another description</p>' },
};
const entries: CommentEntry[] = [
    {
        chatName: 'thread-a.eigenchat',
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
        lastAuthorEmail: null,
        lastActivityAt: null,
        messageCount: 3,
        createdAt: new Date(0),
        assignee: null,
        title: 'The title',
    },
];
const RECT = new DOMRect(100, 200, 10, 20);

// happy-dom lays nothing out, so with a viewport of no size floating-ui would flip the card to the other side.
Object.defineProperty(document.documentElement, 'clientWidth', { value: 1024 });
Object.defineProperty(document.documentElement, 'clientHeight', { value: 768 });

// Renders the card under a host that holds the target, as useCommentHover does, and closes on dismiss.
async function renderCard(cardId: string | null, isCardDeleted: (card: CommentCard) => boolean = () => false) {
    const seen: { setTarget: (target: CommentHoverTarget | null) => void } = { setTarget: () => {} };
    const dismiss = mock(() => seen.setTarget(null));
    const enterCard = mock(() => {});
    const leaveCard = mock(() => {});
    const onOpenCard = mock((_cardId: string) => {});
    function Host() {
        const [target, setTarget] = useState<CommentHoverTarget | null>(cardId ? { cardId, rect: RECT } : null);
        seen.setTarget = setTarget;
        return createElement(CommentHoverCard, {
            hover: { target, show: () => {}, hide: () => {}, enterCard, leaveCard, dismiss },
            cards,
            entries,
            side: 'right',
            isCardDeleted,
            onOpenCard,
        });
    }
    await renderInDocument(createElement(Host));
    return {
        dismiss,
        enterCard,
        leaveCard,
        onOpenCard,
        setTarget: (target: CommentHoverTarget | null) => act(async () => seen.setTarget(target)),
    };
}

const content = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]');
const text = () => document.body.textContent ?? '';
const wrapperTransform = () =>
    document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')?.style.transform;

test('nothing shows without a target', async () => {
    await renderCard(null);
    expect(content()).toBeNull();
});

test('the card shows its title, its description and what its index row holds', async () => {
    await renderCard('a');
    expect(text()).toContain('The title');
    expect(text()).toContain('The description');
    expect(text()).toContain('3 replies');
    expect(content()?.querySelector('.bg-destructive')).toBeNull();
});

test('an untitled card reads as a comment', async () => {
    await renderCard('b');
    expect(text()).toContain('Comment');
    expect(text()).toContain('Another description');
});

test('a card that counts as deleted shows as deleted, without its description', async () => {
    await renderCard('a', (card) => card.id === 'a');
    expect(text()).toContain('The title');
    expect(text()).toContain('This comment was deleted');
    expect(text()).not.toContain('The description');
});

test('a card the host no longer has renders nothing', async () => {
    await renderCard('gone');
    expect(content()).toBeNull();
});

test('the popover is as wide as a board card and draws no frame of its own', async () => {
    await renderCard('a');
    const classes = content()?.className.split(' ') ?? [];
    expect(classes).toContain('w-[254px]');
    expect(classes).toContain('p-0');
    expect(classes).toContain('border-0');
    expect(classes).toContain('bg-transparent');
    expect(classes).toContain('rounded-none');
    expect(classes).not.toContain('w-72');
    expect(classes).not.toContain('p-4');
    expect(content()?.getAttribute('data-align')).toBe('start');
    expect(content()?.getAttribute('data-side')).toBe('right');
});

test('it sits at the rect, and a new target moves it', async () => {
    const { setTarget } = await renderCard('a');
    expect(wrapperTransform()).toBe('translate(114px, 200px)');
    await setTarget({ cardId: 'b', rect: new DOMRect(300, 400, 10, 20) });
    expect(wrapperTransform()).toBe('translate(314px, 400px)');
    expect(text()).toContain('Another description');
});

test('an open card is not a dialog, so a keymap gated on one keeps working', async () => {
    await renderCard('a');
    expect(content()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(content()?.getAttribute('role')).toBe('tooltip');
});

test('a click opens the card and closes the popover', async () => {
    const { onOpenCard, dismiss } = await renderCard('a');
    const frame = content()?.querySelector<HTMLElement>('.cursor-pointer');
    if (!frame) throw new Error('no clickable card');
    await act(async () => frame.click());
    expect(onOpenCard).toHaveBeenCalledWith('a');
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(content()).toBeNull();
});

test('a press on the card leaves the focus where it is, and the click it becomes still opens the card', async () => {
    const { onOpenCard } = await renderCard('a');
    const frame = content()?.querySelector<HTMLElement>('.cursor-pointer');
    if (!frame) throw new Error('no clickable card');
    let kept = true;
    await act(async () => {
        kept = frame.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        frame.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        frame.click();
    });
    expect(kept).toBe(false);
    expect(onOpenCard).toHaveBeenCalledWith('a');
});

test('Escape closes it through the host', async () => {
    const { dismiss } = await renderCard('a');
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(content()).toBeNull();
});

test('opening and closing leave the focus in the editor', async () => {
    const editor = document.createElement('button');
    document.body.append(editor);
    editor.focus();
    const { setTarget } = await renderCard('a');
    expect(content()).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    await setTarget(null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(editor);
    editor.remove();
});

test('the pointer entering and leaving the card tells the host', async () => {
    const { enterCard, leaveCard } = await renderCard('a');
    const element = content();
    if (!element) throw new Error('no popover');
    await act(async () => {
        element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    expect(enterCard).toHaveBeenCalledTimes(1);
    await act(async () => {
        element.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    });
    expect(leaveCard).toHaveBeenCalledTimes(1);
});
