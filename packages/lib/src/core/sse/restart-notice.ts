// What the tab knows about a restart the server announced, such as the one before an update: the notice it last
// heard, with its deadline and the time it was announced on this tab's clock, and whether its event stream is down. The stream fills it, through
// handleSSEvent and useSSE, and the banner reads it through useRestartNotice. A tab that holds a due notice while its
// stream is down knows the server is updating, not broken.

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
    // An older API does not say when it announced, so the tab takes the moment it first heard.
    const announcedAt = msSinceAnnounced === undefined ? undefined : now - msSinceAnnounced;
    const held = state.notice;
    const near = (a: number, b: number) => Math.abs(a - b) < SAME_NOTICE_MS;
    const repeated =
        held?.reason === reason &&
        held.message === message &&
        near(held.deadline, deadline) &&
        (announcedAt === undefined || near(held.heardAt, announcedAt));
    if (repeated) return;
    publish({ ...state, notice: { reason, message, deadline, heardAt: announcedAt ?? now } });
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
