// What the tab knows about a restart the server announced, such as the one before an update: the notice it last
// heard, with its deadline on this tab's clock, and whether its event stream is down. The stream fills it, through
// handleSSEvent and useSSE, and the banner reads it through useRestartNotice. A tab that holds a due notice while its
// stream is down knows the server is updating, not broken.

import type { RestartNoticeState, SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

// Every stream that opens sends the notice again, with msLeft counted at that moment. A deadline that moved less than
// this is the same notice, so the banner keeps the time it was first heard.
const SAME_DEADLINE_MS = 5000;

let state: RestartNoticeState = { notice: null, streamDown: false };
const listeners = new Set<() => void>();

export function handleRestartNoticeSSEvent(event: SSEvent): void {
    if (event.type !== SSEventType.SERVER_RESTART_NOTICE) return;
    if (!event.notice) {
        publish({ ...state, notice: null });
        return;
    }
    const { reason, message, msLeft } = event.notice;
    const now = Date.now();
    const deadline = now + msLeft;
    const held = state.notice;
    const repeated =
        held?.reason === reason && held.message === message && Math.abs(held.deadline - deadline) < SAME_DEADLINE_MS;
    publish({ ...state, notice: { reason, message, deadline, heardAt: repeated ? held.heardAt : now } });
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
