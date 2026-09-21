import { copyToClipboard } from '@workspace/lib/clipboard';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Check, CircleDashed, ClipboardCopy, HelpCircle, X as XIcon } from 'lucide-react';
import { Badge } from '../badge';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { CollapsibleUserList } from '../user/collapsible-user-list';
import { UserItem } from '../user/user-item';

// How a reply reads, for the list here and for the editor that collects the replies (apps/calendar).
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
    attendees: Attendee[];
    organizer?: { userId?: string; email: string; name?: string } | null;
    // Guests a capped payload did not carry: they count in the header, but there is no reply to show.
    remaining?: number;
};

// The guests of an event, read-only: the organizer first, then everyone else with the reply they gave.
export function AttendeeList({ attendees, organizer, remaining = 0 }: AttendeeListProps) {
    const filteredAttendees = organizer
        ? attendees.filter((a) => a.email.toLowerCase() !== organizer.email.toLowerCase())
        : attendees;

    const count = filteredAttendees.length + (organizer ? 1 : 0) + remaining;
    const title = count === 1 ? '1 guest' : `${count} guests`;
    const summary = buildAttendeeSummary(attendees);

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

function buildAttendeeSummary(attendees: Attendee[]): string {
    const counts: Record<string, number> = {};
    for (const a of attendees) {
        counts[a.status] = (counts[a.status] || 0) + 1;
    }
    const parts: string[] = [];
    if (counts.accepted) parts.push(`${counts.accepted} accepted`);
    if (counts.tentative) parts.push(`${counts.tentative} maybe`);
    if (counts.pending) parts.push(`${counts.pending} pending`);
    if (counts.declined) parts.push(`${counts.declined} declined`);
    return parts.join(', ');
}
