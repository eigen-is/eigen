import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import type { SSEventRestartNotice } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { handleRestartNoticeSSEvent, readRestartNotice, setStreamDown } from '../../../core/sse/restart-notice';

const NOW = new Date('2026-11-02T14:22:00Z').getTime();

const noticeEvent = (notice: SSEventRestartNotice['notice']): SSEventRestartNotice => ({
    type: SSEventType.SERVER_RESTART_NOTICE,
    notice,
});
const update = (msLeft: number, message: string | null = null) => noticeEvent({ reason: 'update', msLeft, message });

beforeEach(() => setSystemTime(NOW));
afterEach(() => {
    handleRestartNoticeSSEvent(noticeEvent(null));
    setStreamDown(false);
    setSystemTime();
});

test('a notice is held with its deadline counted from msLeft on this clock', () => {
    handleRestartNoticeSSEvent(update(600_000, 'Back at three'));
    expect(readRestartNotice()).toEqual({
        notice: { reason: 'update', message: 'Back at three', deadline: NOW + 600_000, heardAt: NOW },
        streamDown: false,
    });
});

test('a notice of null drops the one held', () => {
    handleRestartNoticeSSEvent(update(600_000));
    handleRestartNoticeSSEvent(noticeEvent(null));
    expect(readRestartNotice().notice).toBeNull();
});

test('the same notice sent again by a new stream keeps the time it was first heard', () => {
    handleRestartNoticeSSEvent(update(600_000));
    setSystemTime(NOW + 30_000);
    handleRestartNoticeSSEvent(update(570_000));
    expect(readRestartNotice().notice).toEqual({
        reason: 'update',
        message: null,
        deadline: NOW + 600_000,
        heardAt: NOW,
    });
});

test('a notice with another time, reason or message is heard anew', () => {
    handleRestartNoticeSSEvent(update(600_000));
    // The launcher announces again for now once the backup after the wait is done.
    setSystemTime(NOW + 720_000);
    handleRestartNoticeSSEvent(update(0));
    expect(readRestartNotice().notice?.heardAt).toBe(NOW + 720_000);

    setSystemTime(NOW + 721_000);
    handleRestartNoticeSSEvent(update(0, 'Back at three'));
    expect(readRestartNotice().notice?.heardAt).toBe(NOW + 721_000);

    setSystemTime(NOW + 722_000);
    handleRestartNoticeSSEvent(noticeEvent({ reason: 'rollback', msLeft: 0, message: 'Back at three' }));
    expect(readRestartNotice().notice?.heardAt).toBe(NOW + 722_000);
});

test('the snapshot changes only when the stream state does', () => {
    const before = readRestartNotice();
    setStreamDown(false);
    expect(readRestartNotice()).toBe(before);
    setStreamDown(true);
    expect(readRestartNotice()).toEqual({ notice: null, streamDown: true });
});
