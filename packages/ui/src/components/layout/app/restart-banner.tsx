// The strip a signed-in app shows when the server announced a restart, such as before an update, so its user can
// save in time. It reads like the broadcast `shutdown` sends to every terminal. First comes the time the message
// came, then what is about to happen and when, then the operator's own line as plain text. AppShell renders it at the
// foot of every page, and it shows nothing while the tab holds no notice. The strip is a status region, so a screen
// reader speaks it. It hears the clock time of the restart, not the countdown, which would be read out every second.
// A demo's reset counts down in minutes and seconds, since its five minutes are short enough to watch.

import { dateFormatter, formatDayMonth } from '@workspace/lib/date';
import { useRestartNotice } from '@workspace/lib/sse';
import type { HeldRestartNotice, RestartReason } from '@workspace/lib/types/sse';
import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const UPDATE_WORDS = {
    soon: 'Eigen restarts for an update',
    due: 'Eigen is about to restart for an update',
    warning: "Send or save what you're writing.",
    away: 'Eigen is updating.',
    after: ' This page reloads by itself afterwards.',
};
const ROLLBACK_WORDS = {
    soon: 'Eigen goes back to an earlier version',
    due: 'Eigen is about to go back to an earlier version',
    warning: "What you change from now on won't be in it.",
    away: 'Eigen is going back to an earlier version.',
    after: ' This page reloads by itself afterwards.',
};
const DEMO_RESET_WORDS = {
    soon: 'This demo resets',
    due: 'This demo is about to reset',
    warning: 'Everything made here will be wiped.',
    away: 'This demo is resetting.',
    after: '',
};

const RESTART_WORDS: Record<RestartReason, typeof UPDATE_WORDS> = {
    update: UPDATE_WORDS,
    rollback: ROLLBACK_WORDS,
    'demo-reset': DEMO_RESET_WORDS,
};

export function RestartBanner() {
    const { notice, streamDown } = useRestartNotice();
    if (!notice) return null;
    // Keyed by heardAt, the time it was announced, so a new notice starts its countdown from a fresh clock. A repeat
    // of the same notice keeps heardAt, and with it the status region a screen reader already knows.
    return <RestartBroadcast key={notice.heardAt} notice={notice} streamDown={streamDown} />;
}

function RestartBroadcast({ notice, streamDown }: { notice: HeldRestartNotice; streamDown: boolean }) {
    const [now, setNow] = useState(Date.now);
    const msLeft = notice.deadline - now;

    // Wakes when the text would change: on the minute while more than one is left, then every second. A demo's reset
    // ticks every second throughout.
    useEffect(() => {
        if (msLeft <= 0) return;
        const unit = msLeft > MINUTE_MS && notice.reason !== 'demo-reset' ? MINUTE_MS : SECOND_MS;
        const timer = setTimeout(() => setNow(Date.now()), msLeft % unit || unit);
        return () => clearTimeout(timer);
    }, [msLeft, notice.reason]);

    // "Mon 2 Nov, 14:22", the clock time a terminal stamps on a broadcast.
    const heard = new Date(notice.heardAt);
    const heardTime = `${dateFormatter({ weekday: 'short' }).format(heard)} ${formatDayMonth(heard)}, ${clockTime(heard)}`;
    const { lead, when, tail } = restartParts(notice, msLeft, streamDown);
    return (
        <div role="status" className="shrink-0 border-t border-warning/40 bg-warning/10 app-gutter-x py-1.5 text-xs">
            <p className="font-mono text-muted-foreground">Broadcast message from Eigen ({heardTime}):</p>
            <p>
                {lead}
                {when && (
                    <>
                        <span aria-hidden="true"> {when}</span>
                        <span className="sr-only"> at {clockTime(new Date(notice.deadline))}</span>
                    </>
                )}
                {tail}
            </p>
            {notice.message && <p>“{notice.message}”</p>}
        </div>
    );
}

// "14:22", in the user's own time zone.
function clockTime(date: Date): string {
    return dateFormatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

// The sentence in three parts, so the ticking `when` can sit apart from the words that only change with the state.
function restartParts({ reason }: HeldRestartNotice, msLeft: number, streamDown: boolean) {
    const { soon, due, warning, away, after } = RESTART_WORDS[reason];
    if (msLeft > 0) {
        const seconds = Math.ceil(msLeft / SECOND_MS);
        const when =
            reason === 'demo-reset'
                ? `in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                : msLeft > MINUTE_MS
                  ? `in ${Math.ceil(msLeft / MINUTE_MS)} minutes`
                  : `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
        return { lead: soon, when, tail: `. ${warning}${after}` };
    }
    // A stream that dropped once the time had come is the restart itself, not a crash.
    const text = streamDown ? `${away} This page reloads when it's back.` : `${due}. ${warning}`;
    return { lead: text, when: null, tail: '' };
}
