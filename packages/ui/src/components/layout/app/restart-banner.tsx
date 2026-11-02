// The strip a signed-in app shows when the server announced a restart, such as before an update, so its user can
// save in time. It reads like the broadcast `shutdown` sends to every terminal. First comes the time the message
// came, then what is about to happen and when, then the operator's own line as plain text. AppShell renders it at the
// foot of every page, and it shows nothing while the tab holds no notice. The strip is a status region, so a screen
// reader speaks it. It hears the clock time of the restart, not the countdown, which would be read out every second.

import { dateFormatter, formatDayMonth } from '@workspace/lib/date';
import { useRestartNotice } from '@workspace/lib/sse';
import type { HeldRestartNotice } from '@workspace/lib/types/sse';
import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const UPDATE_WORDS = {
    soon: 'Eigen restarts for an update',
    due: 'Eigen is about to restart for an update',
    warning: "Send or save what you're writing.",
    away: 'Eigen is updating.',
};
const ROLLBACK_WORDS = {
    soon: 'Eigen goes back to an earlier version',
    due: 'Eigen is about to go back to an earlier version',
    warning: "What you change from now on won't be in it.",
    away: 'Eigen is going back to an earlier version.',
};

export function RestartBanner() {
    const { notice, streamDown } = useRestartNotice();
    if (!notice) return null;
    // Keyed by the time it was announced, so a new notice starts its countdown from a fresh clock, and one whose
    // deadline moved keeps the status region a screen reader already knows.
    return <RestartBroadcast key={notice.heardAt} notice={notice} streamDown={streamDown} />;
}

function RestartBroadcast({ notice, streamDown }: { notice: HeldRestartNotice; streamDown: boolean }) {
    const [now, setNow] = useState(Date.now);
    const msLeft = notice.deadline - now;

    // Wakes when the text would change: on the minute while more than one is left, then every second.
    useEffect(() => {
        if (msLeft <= 0) return;
        const unit = msLeft > MINUTE_MS ? MINUTE_MS : SECOND_MS;
        const timer = setTimeout(() => setNow(Date.now()), msLeft % unit || unit);
        return () => clearTimeout(timer);
    }, [msLeft]);

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
    const { soon, due, warning, away } = reason === 'update' ? UPDATE_WORDS : ROLLBACK_WORDS;
    if (msLeft > 0) {
        const seconds = Math.ceil(msLeft / SECOND_MS);
        const when =
            msLeft > MINUTE_MS
                ? `in ${Math.ceil(msLeft / MINUTE_MS)} minutes`
                : `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
        return { lead: soon, when, tail: `. ${warning} This page reloads by itself afterwards.` };
    }
    // A stream that dropped once the time had come is the restart itself, not a crash.
    const text = streamDown ? `${away} This page reloads when it's back.` : `${due}. ${warning}`;
    return { lead: text, when: null, tail: '' };
}
