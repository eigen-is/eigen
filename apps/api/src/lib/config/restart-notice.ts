// The restart ./eigen announces before it stops Eigen, such as for an update, so every open tab can warn its user in
// time. The launcher sets and clears it through the control socket. Each change goes out on every open stream, and
// a stream that opens sends what there is. It lives in this process alone, so the restart it announces drops it, and
// one whose restart does not come drops itself a few minutes after its time.

import type { RestartReason, SSEventRestartNotice } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { broadcastToLoadedHomes } from '../home/get-home';

// Room for what follows the announced time and still runs on this server: the backup, the handover and the stop.
// A launcher that died meanwhile, such as one killed with -9, takes no notice back.
const EXPIRY_MS = 5 * 60_000;

export type AnnouncedRestart = { at: string };

type RestartNotice = { at: number; reason: RestartReason; message: string | null };

let current: RestartNotice | null = null;
let expiry: Timer | undefined;

// Replaces any notice there is, and starts its expiry over.
export function announceRestart(inSeconds: number, reason: RestartReason, message: string | null): AnnouncedRestart {
    clearTimeout(expiry);
    const at = Date.now() + inSeconds * 1000;
    current = { at, reason, message };
    expiry = setTimeout(clearRestartNotice, inSeconds * 1000 + EXPIRY_MS);
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
    const { at, reason, message } = current;
    return {
        type: SSEventType.SERVER_RESTART_NOTICE,
        notice: { reason, message, msLeft: Math.max(0, at - Date.now()) },
    };
}
