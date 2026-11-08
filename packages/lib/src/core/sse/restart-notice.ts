// What the tab knows about a restart the server announced, such as the one before an update. It holds the notice it
// last heard, dated on this tab's clock, and whether the tab's event stream is down. The stream fills it, through
// handleSSEvent and useSSE, and the banner reads it through useRestartNotice. A tab that holds a due notice while its
// stream is down knows the server is restarting, not broken.

import type { RestartNoticeState, SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

// Every stream that opens sends the notice again, with its times counted at that moment. Times that moved less than
// this are the same notice, so the tab keeps the one it holds and the banner does not start over.
const SAME_NOTICE_MS = 5000;

let state: RestartNoticeState = { notice: null, streamDown: false };
const listeners = new Set<() => void>();

export function handleRestartNoticeSSEvent(event: SSEvent): void {
    if (event.type !== SSEventType.SERVER_RESTART_NOTICE) return;
    if (!event.notice) {
        publish({ ...state, notice: null });
        return;
    }
    const { reason, message, msLeft, msSinceAnnounced } = event.notice;
    const now = Date.now();
    const deadline = now + msLeft;
    const heardAt = now - msSinceAnnounced;
    const held = state.notice;
    const near = (a: number, b: number) => Math.abs(a - b) < SAME_NOTICE_MS;
    const repeated =
        held?.reason === reason &&
        held.message === message &&
        near(held.deadline, deadline) &&
        near(held.heardAt, heardAt);
    if (repeated) return;
    publish({ ...state, notice: { reason, message, deadline, heardAt } });
}

export function setStreamDown(streamDown: boolean): void {
    if (state.streamDown !== streamDown) publish({ ...state, streamDown });
}

export function readRestartNotice(): RestartNoticeState {
    return state;
}

export function subscribeRestartNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function publish(next: RestartNoticeState): void {
    state = next;
    for (const listener of listeners) listener();
}
