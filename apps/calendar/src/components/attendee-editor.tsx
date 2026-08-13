import { copyToClipboard } from '@workspace/lib/clipboard';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { ContactAddRow } from '@workspace/ui/components/contacts/contact-add-row';
import { useContactInput } from '@workspace/ui/components/contacts/use-contact-input';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { CollapsibleUserList } from '@workspace/ui/components/user/collapsible-user-list';
import { UserItem } from '@workspace/ui/components/user/user-item';
import { Check, CircleDashed, ClipboardCopy, HelpCircle, X as XIcon } from 'lucide-react';
import { useCallback } from 'react';
import { toast } from 'sonner';

type AttendeeEditorProps = {
    attendees: Attendee[];
    onChange: (attendees: Attendee[]) => void;
    currentUserEmail?: string;
};

const statusIcon: Record<Attendee['status'], typeof Check> = {
    accepted: Check,
    declined: XIcon,
    tentative: HelpCircle,
    pending: CircleDashed,
};

const statusLabel: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Maybe',
    pending: 'Pending',
};

export function AttendeeEditor({ attendees, onChange, currentUserEmail }: AttendeeEditorProps) {
    const contactInput = useContactInput((contact) => {
        const email = contact.email;
        if (!attendees.some((a) => a.email.toLowerCase() === email)) {
            if (currentUserEmail && email === currentUserEmail.toLowerCase()) {
                toast.info('You cannot invite yourself');
            } else {
                const name = contact.displayName !== email ? contact.displayName : undefined;
                onChange([...attendees, { email, name, status: 'pending', role: 'required' }]);
            }
        }
        return true;
    });

    const removeAttendee = useCallback(
        (email: string) => {
            onChange(attendees.filter((a) => a.email !== email));
        },
        [attendees, onChange],
    );

    return (
        <div className="space-y-2">
            <ContactAddRow
                id="attendee-input"
                value={contactInput.value}
                onChange={contactInput.handleChange}
                onSubmit={contactInput.submit}
                placeholder="Add guests"
            />

            {attendees.length > 0 && (
                <div className="space-y-1">
                    {attendees.map((attendee) => {
                        const StatusIcon = statusIcon[attendee.status];
                        return (
                            <div key={attendee.email} className="flex items-center justify-between group">
                                <UserItem email={attendee.email} name={attendee.name} />
                                <div className="flex items-center gap-1">
                                    <Badge variant="outline" className="text-xs gap-1">
                                        <StatusIcon className="h-3 w-3" />
                                        {statusLabel[attendee.status]}
                                    </Badge>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
                                        onClick={() => removeAttendee(attendee.email)}
                                    >
                                        <XIcon className="h-3 w-3" />
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

type AttendeeListProps = {
    attendees: Attendee[];
    organizer?: { userId?: string; email: string; name?: string };
};

export function AttendeeList({ attendees, organizer }: AttendeeListProps) {
    const filteredAttendees = organizer
        ? attendees.filter((a) => a.email.toLowerCase() !== organizer.email.toLowerCase())
        : attendees;

    const count = filteredAttendees.length + (organizer ? 1 : 0);
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
            {filteredAttendees.map((attendee) => {
                const StatusIcon = statusIcon[attendee.status];
                return (
                    <div key={attendee.email} className="flex items-center justify-between">
                        <UserItem email={attendee.email} name={attendee.name} />
                        <Badge variant="outline" className="text-xs gap-1">
                            <StatusIcon className="h-3 w-3" />
                            {statusLabel[attendee.status]}
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
