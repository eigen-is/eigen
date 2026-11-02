// The banner a signed-in tab shows when the server announced a restart, read like the broadcast `shutdown` sends to
// every terminal: when the message came, what is about to happen, and the operator's own line, as plain text.
import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import type { RestartNoticeState } from '@workspace/lib/types/sse';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

let state: RestartNoticeState = { notice: null, streamDown: false };
const realSse = await import('@workspace/lib/sse');
mock.module('@workspace/lib/sse', () => ({ ...realSse, useRestartNotice: () => state }));
afterAll(() => {
    mock.module('@workspace/lib/sse', () => realSse);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RestartBanner } = await import('../../../../components/layout/app/restart-banner');

// Monday 2 November 2026, 14:22 on this machine's clock.
const NOW = new Date(2026, 10, 2, 14, 22).getTime();

const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);

async function show(next: RestartNoticeState): Promise<string> {
    state = next;
    await act(async () => root.render(createElement(RestartBanner)));
    return container.textContent ?? '';
}

// What a screen reader announces: the status region without what it hides.
function spoken(): string {
    const region = container.querySelector('[role="status"]')?.cloneNode(true);
    if (!(region instanceof Element)) return '';
    region.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => void hidden.remove());
    return region.textContent ?? '';
}

const update = (msLeft: number, message: string | null = null): RestartNoticeState['notice'] => ({
    reason: 'update',
    message,
    deadline: NOW + msLeft,
    heardAt: NOW,
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
});
afterEach(async () => {
    await act(async () => root.render(null));
    jest.useRealTimers();
});

test('nothing shows without a notice', async () => {
    expect(await show({ notice: null, streamDown: false })).toBe('');
    expect(container.childElementCount).toBe(0);
});

test('an update ten minutes away reads as a broadcast with the time it came', async () => {
    const text = await show({ notice: update(600_000), streamDown: false });
    expect(text).toBe(
        'Broadcast message from Eigen (Mon 2 Nov, 14:22):' +
            "Eigen restarts for an update in 10 minutes at 14:32. Send or save what you're writing. " +
            'This page reloads by itself afterwards.',
    );
});

test('in the last minute a rollback counts in seconds', async () => {
    const text = await show({
        notice: { reason: 'rollback', message: null, deadline: NOW + 45_000, heardAt: NOW },
        streamDown: false,
    });
    expect(text).toContain(
        "Eigen goes back to an earlier version in 45 seconds at 14:22. What you change from now on won't be in it. " +
            'This page reloads by itself afterwards.',
    );
});

test('an update or a rollback whose time has come is about to happen', async () => {
    expect(await show({ notice: update(0), streamDown: false })).toContain(
        "Eigen is about to restart for an update. Send or save what you're writing.",
    );
    expect(
        await show({ notice: { reason: 'rollback', message: null, deadline: NOW, heardAt: NOW }, streamDown: false }),
    ).toContain("Eigen is about to go back to an earlier version. What you change from now on won't be in it.");
});

test('with the stream down and the time come, the server is updating', async () => {
    const text = await show({ notice: update(0), streamDown: true });
    expect(text).toContain("Eigen is updating. This page reloads when it's back.");
    expect(text).not.toContain('about to restart');
});

test('the operator message shows as text, never as markup', async () => {
    const text = await show({ notice: update(600_000, '<b>Back at three</b>'), streamDown: false });
    expect(text).toContain('<b>Back at three</b>');
    expect(container.querySelector('b')).toBeNull();
});

test('the countdown moves on by the minute, then by the second', async () => {
    // A second at a time: each tick renders, and the render sets the next timer.
    const tick = async (ms: number) => {
        for (let passed = 0; passed < ms; passed += 1000) await act(async () => void jest.advanceTimersByTime(1000));
    };
    expect(await show({ notice: update(150_000), streamDown: false })).toContain('in 3 minutes');
    await tick(30_000);
    expect(container.textContent).toContain('in 2 minutes');
    await tick(60_000);
    expect(container.textContent).toContain('in 60 seconds');
    await tick(15_000);
    expect(container.textContent).toContain('in 45 seconds');
    await tick(44_000);
    expect(container.textContent).toContain('in 1 second at');
    await tick(1000);
    expect(container.textContent).toContain('Eigen is about to restart for an update.');
});

test('the banner is a status region that announces the clock time of the restart, not the ticking time', async () => {
    expect(await show({ notice: update(600_000), streamDown: false })).toContain('in 10 minutes');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('.sr-only')?.textContent).toBe(' at 14:32');
    expect(spoken()).toContain('Eigen restarts for an update at 14:32. Send or save');
    expect(spoken()).not.toContain('minutes');
    // The announced words stay the same while the countdown moves on.
    await act(async () => void jest.advanceTimersByTime(60_000));
    expect(container.textContent).toContain('in 9 minutes');
    expect(spoken()).toContain('Eigen restarts for an update at 14:32. Send or save');
});
