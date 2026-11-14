// An event's guests, read-only: the organizer first, then everyone else with their reply, under a count and a tally of
// the replies, with a button that copies the addresses. It also owns how a reply reads, its icon and its label, for
// other views of the guests such as the editor that collects them. It shows wherever someone reads an event's guests,
// such as its detail card.

import { copyToClipboard } from '@workspace/lib/clipboard';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Check, CircleDashed, ClipboardCopy, HelpCircle, X as XIcon } from 'lucide-react';
import { Badge } from '../badge';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { CollapsibleUserList } from '../user/collapsible-user-list';
import { UserItem } from '../user/user-item';

export const ATTENDEE_STATUS_ICON: Record<Attendee['status'], typeof Check> = {
    accepted: Check,
    declined: XIcon,
    tentative: HelpCircle,
    pending: CircleDashed,
};

export const ATTENDEE_STATUS_LABEL: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Maybe',
    pending: 'Pending',
};

type AttendeeListProps = {
    attendees: readonly Attendee[];
    organizer?: { userId?: string; email: string; name?: string } | null;
    // Guests a capped payload did not carry: they count in the header, but there is no reply to show.
    remaining?: number;
};

export function AttendeeList({ attendees, organizer, remaining = 0 }: AttendeeListProps) {
    const organizerEmail = organizer?.email.toLowerCase();
    const filteredAttendees = attendees.filter((a) => a.email.toLowerCase() !== organizerEmail);
    // An organizer the file lists only as organizer has no reply of their own, and organizing is accepting.
    const organizerReply = attendees.find((a) => a.email.toLowerCase() === organizerEmail)?.status ?? 'accepted';

    const count = filteredAttendees.length + (organizer ? 1 : 0) + remaining;
    const title = count === 1 ? '1 guest' : `${count} guests`;
    // The replies of the listed guests are the whole event's only when the payload carried them all.
    const statuses = filteredAttendees.map((a) => a.status);
    if (organizer) statuses.push(organizerReply);
    const summary = remaining === 0 ? buildAttendeeSummary(statuses) : '';

    const handleCopyEmails = () => {
        const emails = filteredAttendees.map((a) => a.email);
        if (organizer) emails.unshift(organizer.email);
        copyToClipboard(emails.join(', '), 'Emails copied to clipboard');
    };

    return (
        <CollapsibleUserList
            title={title}
            summaryLines={summary ? [summary] : undefined}
            count={count}
            actions={
                <TooltipButton
                    icon={ClipboardCopy}
                    tooltipText="Copy emails"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={handleCopyEmails}
                />
            }
        >
            {organizer && (
                <div className="flex items-center justify-between">
                    <UserItem email={organizer.email} name={organizer.name} />
                    <Badge variant="outline" className="text-xs">
                        Organizer
                    </Badge>
                </div>
            )}
            {filteredAttendees.map((attendee, index) => {
                const StatusIcon = ATTENDEE_STATUS_ICON[attendee.status];
                // Index beside the address: a file may list the same one twice.
                return (
                    <div key={`${index}-${attendee.email}`} className="flex items-center justify-between">
                        <UserItem email={attendee.email} name={attendee.name} />
                        <Badge variant="outline" className="text-xs gap-1">
                            <StatusIcon className="h-3 w-3" />
                            {ATTENDEE_STATUS_LABEL[attendee.status]}
                        </Badge>
                    </div>
                );
            })}
        </CollapsibleUserList>
    );
}

function buildAttendeeSummary(statuses: readonly Attendee['status'][]): string {
    const counts: Partial<Record<Attendee['status'], number>> = {};
    for (const status of statuses) {
        counts[status] = (counts[status] ?? 0) + 1;
    }
    const parts: string[] = [];
    if (counts.accepted) parts.push(`${counts.accepted} accepted`);
    if (counts.tentative) parts.push(`${counts.tentative} maybe`);
    if (counts.pending) parts.push(`${counts.pending} pending`);
    if (counts.declined) parts.push(`${counts.declined} declined`);
    return parts.join(', ');
}
