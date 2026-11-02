// ./eigen update, rollback and restore run this before they stop Eigen: it tells every open tab, through the running
// API's control socket, that Eigen restarts in so many seconds, with the operator's own line if there is one, and
// prints when. --clear takes the notice back, when the operator cancels the wait or the command fails. Its flags are
// what one version's launcher asks of another version's CLI, so they stay as they are.

import type { parseArgs } from 'node:util';
import { RESTART_REASONS } from '@workspace/lib/types/sse';
import {
    MAX_RESTART_MESSAGE_LENGTH,
    MAX_RESTART_WAIT_SECONDS,
    RESTART_NOTICE_EXPIRY_MS,
} from '@workspace/lib/validation';
import type { AnnouncedRestart } from '../lib/config/restart-notice';
import { callControl } from './control-socket';
import type { Ui } from './ui';
import { createUi, refuseUsage } from './ui';

// The control socket sets no timeout, and the launcher takes a notice back as it exits. A hung API must not hold
// that exit, so each call gives up after this and fails instead.
const CALL_TIMEOUT_MS = 10_000;

export const RESTART_NOTICE_OPTIONS = {
    in: { type: 'string' },
    reason: { type: 'string' },
    message: { type: 'string' },
    clear: { type: 'boolean' },
} as const;
export const RESTART_NOTICE_USAGE = `Usage: restart-notice --in <seconds> --reason update|rollback [--message <text>]
       restart-notice --clear

Tells every open tab that Eigen restarts in <seconds>, and prints at=<time> it comes. A new
notice replaces the one there is. The tabs drop one whose restart has not come ${RESTART_NOTICE_EXPIRY_MS / 60_000} minutes
after its time.

  --in       Seconds until the restart, 0 to ${MAX_RESTART_WAIT_SECONDS}
  --reason   update or rollback, which the tabs say
  --message  A line of up to ${MAX_RESTART_MESSAGE_LENGTH} characters the tabs show with it
  --clear    Take the notice back: Eigen does not restart`;

type RestartNoticeFlags = ReturnType<typeof parseArgs<{ options: typeof RESTART_NOTICE_OPTIONS }>>['values'];

export async function restartNotice(flags: RestartNoticeFlags): Promise<void> {
    const ui = await createUi(true);
    const failed = async (res: Response): Promise<never> =>
        ui.fail(await answerText(res), 'Run ./eigen logs eigen-api to see what went wrong.');
    if (flags.clear) {
        if (flags.in !== undefined || flags.reason !== undefined || flags.message !== undefined)
            return refuseUsage('--clear takes no other flag.', RESTART_NOTICE_USAGE);
        const res = await callNotice(ui, { method: 'DELETE' });
        if (!res.ok) await failed(res);
        return;
    }

    const inSeconds = Number(flags.in);
    const reason = RESTART_REASONS.find((candidate) => candidate === flags.reason);
    // A tab shows the line as it is, so a newline or a terminal escape becomes a space.
    const message = flags.message?.replace(/\p{Cc}/gu, ' ').trim() || undefined;
    if (!/^\d+$/.test(flags.in ?? '') || inSeconds > MAX_RESTART_WAIT_SECONDS)
        return refuseUsage(`--in takes whole seconds up to ${MAX_RESTART_WAIT_SECONDS}.`, RESTART_NOTICE_USAGE);
    if (!reason) return refuseUsage(`--reason takes ${RESTART_REASONS.join(' or ')}.`, RESTART_NOTICE_USAGE);
    if (message && message.length > MAX_RESTART_MESSAGE_LENGTH)
        return refuseUsage(`The message is over ${MAX_RESTART_MESSAGE_LENGTH} characters.`, RESTART_NOTICE_USAGE);

    const res = await callNotice(ui, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inSeconds, reason, message }),
    });
    if (!res.ok) await failed(res);
    // The timeout also covers reading the answer, which an API that stalls mid-answer never finishes.
    const announced: AnnouncedRestart | null = await res.json().catch(() => null);
    if (!announced) return notAnswering(ui);
    console.log(`at=${announced.at}`);
}

// One call to the notice route, given up after CALL_TIMEOUT_MS. A socket that is not there means Eigen is down.
async function callNotice(ui: Ui, init: BunFetchRequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const fail = (): never =>
        signal.aborted
            ? notAnswering(ui)
            : ui.fail('Eigen is not running, so no tab is open to tell.', 'Start it with ./eigen restart.');
    return callControl('/restart-notice', fail, { ...init, signal });
}

function notAnswering(ui: Ui): never {
    return ui.fail('Eigen is not answering.', 'Run ./eigen logs eigen-api to see what it is doing.');
}

// The API's own words for a refusal, or that it stopped answering partway.
function answerText(res: Response): Promise<string> {
    return res.text().catch(() => 'Eigen is not answering.');
}
