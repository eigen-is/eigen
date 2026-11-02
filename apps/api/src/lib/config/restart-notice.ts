// The restart ./eigen announces before it stops Eigen, such as for an update, so every open tab can warn its user in
// time. The launcher sets and clears it through the control socket. Each change goes out on every open stream, and
// a stream that opens sends what there is. It lives in this process alone, so the restart it announces drops it, and
// one whose restart does not come drops itself a few minutes after its time.

import type { RestartReason, SSEventRestartNotice } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { RESTART_NOTICE_EXPIRY_MS } from '@workspace/lib/validation';
import { broadcastToLoadedHomes } from '../home/get-home';

export type AnnouncedRestart = { at: string };

// `announcedAt` and `at` are this server's clock, in milliseconds.
type RestartNotice = { announcedAt: number; at: number; reason: RestartReason; message: string | null };

let current: RestartNotice | null = null;
let expiry: Timer | undefined;

// Replaces any notice there is, and starts its expiry over.
export function announceRestart(inSeconds: number, reason: RestartReason, message: string | null): AnnouncedRestart {
    clearTimeout(expiry);
    const announcedAt = Date.now();
    const at = announcedAt + inSeconds * 1000;
    current = { announcedAt, at, reason, message };
    expiry = setTimeout(clearRestartNotice, inSeconds * 1000 + RESTART_NOTICE_EXPIRY_MS);
    // A notice must never hold the process open at shutdown.
    expiry.unref();
    broadcastToLoadedHomes(buildRestartNoticeEvent());
    return { at: new Date(at).toISOString() };
}

export function clearRestartNotice(): void {
    clearTimeout(expiry);
    if (!current) return;
    current = null;
    broadcastToLoadedHomes(buildRestartNoticeEvent());
}

export function buildRestartNoticeEvent(): SSEventRestartNotice {
    if (!current) return { type: SSEventType.SERVER_RESTART_NOTICE, notice: null };
    const { announcedAt, at, reason, message } = current;
    const now = Date.now();
    return {
        type: SSEventType.SERVER_RESTART_NOTICE,
        notice: { reason, message, msLeft: Math.max(0, at - now), msSinceAnnounced: now - announcedAt },
    };
}
