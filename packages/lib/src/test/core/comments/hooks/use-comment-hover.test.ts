// When a comment's hover card opens and closes: a pause before it opens, a grace before it closes so the pointer can
// reach it, and a hold while the pointer is on it, since a host keeps reporting "left" from its own mouse-move.
import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import type { CommentHover } from '../../../../types/comments';
import { installHappyDom } from '../../../happy-dom';

const dom = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCommentHover } = await import('../../../../core/comments/hooks/use-comment-hover');

const RECT = new dom.DOMRect(1, 2, 3, 4);
const OTHER_RECT = new dom.DOMRect(5, 6, 7, 8);

let unmount = async () => {};

async function mountHover() {
    const seen: { hover: CommentHover | null } = { hover: null };
    function Harness() {
        seen.hover = useCommentHover();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness)));
    unmount = async () => {
        await act(async () => root.unmount());
        unmount = async () => {};
    };
    return () => {
        if (!seen.hover) throw new Error('the hook did not render');
        return seen.hover;
    };
}

const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
const run = (action: () => void) => act(async () => action());

// A hook with card `a` open at RECT.
async function mountOpen() {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(300);
    return hover;
}

beforeEach(() => {
    jest.useFakeTimers();
});
afterEach(async () => {
    await unmount();
    jest.useRealTimers();
    dom.happyDOM.settings.navigator.maxTouchPoints = 0;
});

test('show opens after the pause, at the rect it was given', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(299);
    expect(hover().target).toBeNull();
    await advance(1);
    expect(hover().target).toEqual({ cardId: 'a', rect: RECT });
    expect(hover().target?.rect).toBe(RECT);
});

test('repeating show for the pending card keeps its timer and its rect', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(200);
    await run(() => hover().show('a', OTHER_RECT));
    await advance(100);
    expect(hover().target?.rect).toBe(RECT);
});

test('repeating show for the open card leaves it where it is', async () => {
    const hover = await mountOpen();
    const target = hover().target;
    await run(() => hover().show('a', OTHER_RECT));
    expect(hover().target).toBe(target);
});

test('a different card while one is pending waits its own pause', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(200);
    await run(() => hover().show('b', OTHER_RECT));
    await advance(299);
    expect(hover().target).toBeNull();
    await advance(1);
    expect(hover().target).toEqual({ cardId: 'b', rect: OTHER_RECT });
});

test('a different card while one is open switches at once', async () => {
    const hover = await mountOpen();
    await run(() => hover().show('b', OTHER_RECT));
    expect(hover().target).toEqual({ cardId: 'b', rect: OTHER_RECT });
});

test('a switch cancels the pending close', async () => {
    const hover = await mountOpen();
    await run(() => hover().hide());
    await advance(100);
    await run(() => hover().show('b', OTHER_RECT));
    await advance(1000);
    expect(hover().target?.cardId).toBe('b');
});

test('a quick pass over a mark never opens', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(100);
    await run(() => hover().hide());
    expect(jest.getTimerCount()).toBe(0);
    await advance(1000);
    expect(hover().target).toBeNull();
});

test('after a quick pass the same card waits the whole pause again', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await advance(100);
    await run(() => hover().hide());
    await run(() => hover().show('a', RECT));
    await advance(299);
    expect(hover().target).toBeNull();
    await advance(1);
    expect(hover().target?.cardId).toBe('a');
});

test('hide closes after the grace', async () => {
    const hover = await mountOpen();
    await run(() => hover().hide());
    await advance(149);
    expect(hover().target?.cardId).toBe('a');
    await advance(1);
    expect(hover().target).toBeNull();
});

test('a host repeating hide on every move does not push the close back', async () => {
    const hover = await mountOpen();
    for (let at = 0; at < 140; at += 20) {
        await run(() => hover().hide());
        await advance(20);
    }
    await run(() => hover().hide());
    await advance(10);
    expect(hover().target).toBeNull();
});

test('coming back to the open card within the grace keeps it open', async () => {
    const hover = await mountOpen();
    const target = hover().target;
    await run(() => hover().hide());
    await advance(100);
    await run(() => hover().show('a', OTHER_RECT));
    await advance(1000);
    expect(hover().target).toBe(target);
});

test('entering the card within the grace keeps it open, however often the host said it left', async () => {
    const hover = await mountOpen();
    await run(() => hover().hide());
    await advance(50);
    await run(() => hover().hide());
    await advance(50);
    await run(() => hover().enterCard());
    await advance(1000);
    expect(hover().target?.cardId).toBe('a');
});

// The sheet's document mousemove reports "left the grid" on every frame over the portaled card.
test('while the pointer is on the card, repeated hide calls do nothing', async () => {
    const hover = await mountOpen();
    await run(() => hover().enterCard());
    for (let frame = 0; frame < 60; frame++) {
        await run(() => hover().hide());
        await advance(16);
    }
    expect(hover().target?.cardId).toBe('a');
    expect(jest.getTimerCount()).toBe(0);
});

test('leaving the card closes it after the grace', async () => {
    const hover = await mountOpen();
    await run(() => hover().enterCard());
    await run(() => hover().leaveCard());
    await advance(149);
    expect(hover().target?.cardId).toBe('a');
    await advance(1);
    expect(hover().target).toBeNull();
});

test('dismiss closes now, and the next card closes as usual', async () => {
    const hover = await mountOpen();
    await run(() => hover().enterCard());
    await run(() => hover().dismiss());
    expect(hover().target).toBeNull();

    await run(() => hover().show('a', RECT));
    await advance(299);
    expect(hover().target).toBeNull();
    await advance(1);
    expect(hover().target?.cardId).toBe('a');
    await run(() => hover().hide());
    await advance(150);
    expect(hover().target).toBeNull();
});

test('dismiss cancels a pending open and a pending close', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await run(() => hover().dismiss());
    expect(jest.getTimerCount()).toBe(0);
    await advance(1000);
    expect(hover().target).toBeNull();

    await run(() => hover().show('a', RECT));
    await advance(300);
    await run(() => hover().hide());
    await run(() => hover().dismiss());
    expect(jest.getTimerCount()).toBe(0);
});

test('a wheel anywhere closes the open card', async () => {
    const hover = await mountOpen();
    await run(() => window.dispatchEvent(new window.Event('wheel')));
    expect(hover().target).toBeNull();
});

// A scroll doesn't bubble, so only a listener in the capture phase hears one from inside the page.
test('a scroll inside the page closes the open card', async () => {
    const hover = await mountOpen();
    const scroller = document.createElement('div');
    document.body.append(scroller);
    await run(() => scroller.dispatchEvent(new window.Event('scroll')));
    scroller.remove();
    expect(hover().target).toBeNull();
});

test('a wheel or a scroll cancels a pending open', async () => {
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await run(() => window.dispatchEvent(new window.Event('wheel')));
    await advance(1000);
    expect(hover().target).toBeNull();

    await run(() => hover().show('a', RECT));
    await run(() => window.dispatchEvent(new window.Event('scroll')));
    await advance(1000);
    expect(hover().target).toBeNull();
});

test('the page is only listened to while a card is pending or open', async () => {
    const add = spyOn(window, 'addEventListener');
    const remove = spyOn(window, 'removeEventListener');
    const types = (spy: typeof add | typeof remove) => spy.mock.calls.map(([type]) => type);
    const hover = await mountHover();
    expect(types(add)).not.toContain('wheel');
    expect(types(add)).not.toContain('scroll');

    await run(() => hover().show('a', RECT));
    expect(types(add)).toContain('wheel');
    expect(types(add)).toContain('scroll');
    expect(types(remove)).not.toContain('wheel');

    await run(() => hover().hide());
    expect(types(remove)).toContain('wheel');
    expect(types(remove)).toContain('scroll');
    add.mockRestore();
    remove.mockRestore();
});

test('on a coarse pointer show does nothing, since a tap emulates mouse events', async () => {
    dom.happyDOM.settings.navigator.maxTouchPoints = 1;
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    expect(jest.getTimerCount()).toBe(0);
    await advance(1000);
    expect(hover().target).toBeNull();
});

test('unmounting clears a pending open and stops listening', async () => {
    const remove = spyOn(window, 'removeEventListener');
    const hover = await mountHover();
    await run(() => hover().show('a', RECT));
    await unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(remove.mock.calls.map(([type]) => type)).toContain('wheel');
    remove.mockRestore();
});

test('unmounting clears a pending close', async () => {
    const hover = await mountOpen();
    await run(() => hover().hide());
    expect(jest.getTimerCount()).toBe(1);
    await unmount();
    expect(jest.getTimerCount()).toBe(0);
});

test('the actions keep their identity across every state', async () => {
    const hover = await mountHover();
    const { show, hide, enterCard, leaveCard, dismiss } = hover();
    await run(() => show('a', RECT));
    await advance(300);
    expect(hover().target?.cardId).toBe('a');
    await run(() => show('b', OTHER_RECT));
    await run(() => dismiss());
    expect(hover().show).toBe(show);
    expect(hover().hide).toBe(hide);
    expect(hover().enterCard).toBe(enterCard);
    expect(hover().leaveCard).toBe(leaveCard);
    expect(hover().dismiss).toBe(dismiss);
});
