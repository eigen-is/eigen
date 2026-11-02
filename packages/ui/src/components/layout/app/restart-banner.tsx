// The strip a signed-in app shows when the server announced a restart, such as before an update, so its user can
// save in time. It reads like the broadcast `shutdown` sends to every terminal: the time the message came, what is
// about to happen and when, then the operator's own line as plain text. AppShell renders it at the foot of every
// page, and it shows nothing while the tab holds no notice. A screen reader speaks the strip, a status region, with
// the clock time of the restart instead of the ticking countdown, which it would read out again every second.

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
};
const ROLLBACK_WORDS = {
    soon: 'Eigen goes back to an earlier version',
    due: 'Eigen is about to go back to an earlier version',
    warning: "What you change from now on won't be in it.",
};

export function RestartBanner() {
    const { notice, streamDown } = useRestartNotice();
    if (!notice) return null;
    // Keyed by the deadline, so a new notice starts its countdown from a fresh clock.
    return <RestartBroadcast key={notice.deadline} notice={notice} streamDown={streamDown} />;
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

    return (
        <div role="status" className="shrink-0 border-t border-warning/40 bg-warning/10 app-gutter-x py-1.5 text-xs">
            <p className="font-mono text-muted-foreground">
                Broadcast message from Eigen ({broadcastTime(notice.heardAt)}):
            </p>
            <RestartText notice={notice} msLeft={msLeft} streamDown={streamDown} />
            {notice.message && <p>“{notice.message}”</p>}
        </div>
    );
}

// "Mon 2 Nov, 14:22", the clock time a terminal stamps on a broadcast.
function broadcastTime(heardAt: number): string {
    const date = new Date(heardAt);
    const weekday = dateFormatter({ weekday: 'short' }).format(date);
    return `${weekday} ${formatDayMonth(date)}, ${clockTime(date)}`;
}

// "14:22", in the user's own time zone.
function clockTime(date: Date): string {
    return dateFormatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function RestartText({
    notice,
    msLeft,
    streamDown,
}: {
    notice: HeldRestartNotice;
    msLeft: number;
    streamDown: boolean;
}) {
    const { lead, when, tail } = restartParts(notice, msLeft, streamDown);
    return (
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
    );
}

// The sentence in three parts, so the ticking `when` can sit apart from the words that only change with the state.
function restartParts({ reason }: HeldRestartNotice, msLeft: number, streamDown: boolean) {
    const { soon, due, warning } = reason === 'update' ? UPDATE_WORDS : ROLLBACK_WORDS;
    if (msLeft > 0) {
        const seconds = Math.ceil(msLeft / SECOND_MS);
        const when =
            msLeft > MINUTE_MS
                ? `in ${Math.ceil(msLeft / MINUTE_MS)} minutes`
                : `in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
        return { lead: soon, when, tail: `. ${warning} This page reloads by itself afterwards.` };
    }
    // A stream that dropped once the time had come is the restart itself, not a crash.
    const text = streamDown ? "Eigen is updating. This page reloads when it's back." : `${due}. ${warning}`;
    return { lead: text, when: null, tail: '' };
}
