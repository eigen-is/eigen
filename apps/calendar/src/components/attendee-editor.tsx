// The guest list of the event dialogs: a field that adds a guest by address or from the contacts it suggests, and the
// guests below it with their reply and a button that removes one. Inviting yourself is refused with a note. The
// dialog owns the list and saves it with the event.

import type { Attendee } from '@workspace/lib/types/calendar';
import { Badge } from '@workspace/ui/components/badge';
import { ATTENDEE_STATUS_ICON, ATTENDEE_STATUS_LABEL } from '@workspace/ui/components/calendar';
import { ContactAddRow, useContactInput } from '@workspace/ui/components/contacts';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserItem } from '@workspace/ui/components/user';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { X as XIcon } from 'lucide-react';
import { toast } from 'sonner';

type AttendeeEditorProps = {
    attendees: Attendee[];
    onChange: (attendees: Attendee[]) => void;
    currentUserEmail?: string;
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
                        const StatusIcon = ATTENDEE_STATUS_ICON[attendee.status];
                        return (
                            <div key={attendee.email} className="flex items-center justify-between group">
                                <UserItem email={attendee.email} name={attendee.name} />
                                <div className="flex items-center gap-1">
                                    <Badge variant="outline" className="text-xs gap-1">
                                        <StatusIcon className="h-3 w-3" />
                                        {ATTENDEE_STATUS_LABEL[attendee.status]}
                                    </Badge>
                                    <TooltipButton
                                        icon={XIcon}
                                        tooltipText={`Remove ${attendee.email}`}
                                        className={cn(HOVER_REVEAL_CLASS, 'h-6 w-6')}
                                        onClick={() => onChange(attendees.filter((a) => a.email !== attendee.email))}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
