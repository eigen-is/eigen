import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { handleRestartNoticeSSEvent, readRestartNotice, setStreamDown } from '../../../../core/sse/restart-notice';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

// The hook opens its own EventSource, so each test drives a fake through the calls a browser makes: onopen when the
// stream answers, onmessage per event, and onerror with the source CLOSED after an HTTP error such as a 502.
class FakeEventSource {
    public static readonly CLOSED = 2;
    public static instances: FakeEventSource[] = [];
    public readyState = 0;
    public onopen: (() => void) | null = null;
    public onmessage: ((message: { data: string }) => void) | null = null;
    public onerror: (() => void) | null = null;

    public constructor(public url: string) {
        FakeEventSource.instances.push(this);
    }

    public close() {
        this.readyState = FakeEventSource.CLOSED;
    }

    public open() {
        this.readyState = 1;
        this.onopen?.();
    }

    public send(event: SSEvent) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }

    public fail() {
        this.readyState = FakeEventSource.CLOSED;
        this.onerror?.();
    }
}

const realEventSource = globalThis.EventSource;
Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true, writable: true });

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ isAuthenticated: true, user: { id: 'owner-1' } }),
}));

afterAll(() => {
    Object.defineProperty(globalThis, 'EventSource', { value: realEventSource, configurable: true, writable: true });
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { useSSE } = await import('../../../../core/sse/hooks/use-sse');

// The longest a retry waits while a notice is held: 5 s and its jitter of up to 20%.
const NOTICE_RETRY_MS = 6000;

const latest = () => {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('no stream opened');
    return source;
};

let unmount: () => Promise<void>;
beforeEach(async () => {
    jest.useFakeTimers();
    FakeEventSource.instances = [];
    ({ unmount } = await renderHook(() => useSSE(), new QueryClient()));
});
afterEach(async () => {
    await unmount();
    jest.useRealTimers();
    handleRestartNoticeSSEvent({ type: SSEventType.SERVER_RESTART_NOTICE, notice: null });
    setStreamDown(false);
});

test('the stream is down from an error until it opens again', () => {
    latest().open();
    expect(readRestartNotice().streamDown).toBe(false);
    latest().fail();
    expect(readRestartNotice().streamDown).toBe(true);
    jest.advanceTimersByTime(NOTICE_RETRY_MS);
    latest().open();
    expect(readRestartNotice().streamDown).toBe(false);
});

test('while a notice is held, a stream that stays down is retried every few seconds', () => {
    latest().open();
    latest().send({
        type: SSEventType.SERVER_RESTART_NOTICE,
        notice: { reason: 'update', msLeft: 0, msSinceAnnounced: 0, message: null },
    });
    for (let attempt = 1; attempt <= 8; attempt++) {
        latest().fail();
        jest.advanceTimersByTime(NOTICE_RETRY_MS);
        expect(FakeEventSource.instances.length).toBe(attempt + 1);
    }
});

test('without a notice, the retry waits longer each time', () => {
    latest().open();
    // 1 s, 2 s and 4 s, each with its jitter, then 8 s.
    for (let attempt = 1; attempt <= 3; attempt++) {
        latest().fail();
        jest.advanceTimersByTime(NOTICE_RETRY_MS);
        expect(FakeEventSource.instances.length).toBe(attempt + 1);
    }
    latest().fail();
    jest.advanceTimersByTime(NOTICE_RETRY_MS);
    expect(FakeEventSource.instances.length).toBe(4);
});
