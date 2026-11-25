// The guest list of the event dialogs: a field that adds a guest by address or from the contacts it suggests, and the
// guests below it with their reply and a button that removes one. A typed address takes the name of the user's contact
// for it, if there is one. Inviting yourself or a guest already listed is refused under the field. The dialog owns the
// list and, through useGuestInput, the field's text, so its Save counts typed text as a change and adds it first.

import { useAuth } from '@workspace/lib/auth';
import type { Attendee } from '@workspace/lib/types/calendar';
import { Badge } from '@workspace/ui/components/badge';
import { ATTENDEE_STATUS_ICON, ATTENDEE_STATUS_LABEL } from '@workspace/ui/components/calendar';
import { ContactAddRow, useContactInput } from '@workspace/ui/components/contacts';
import { Label } from '@workspace/ui/components/label';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserItem } from '@workspace/ui/components/user';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { X as XIcon } from 'lucide-react';

type GuestList = {
    attendees: readonly Attendee[];
    onChange: (attendees: Attendee[]) => void;
};

type GuestInput = ReturnType<typeof useContactInput> & {
    // The guests with the typed one added, nothing when nothing was typed, or false when the field refuses it and
    // says why.
    commitGuests: () => Attendee[] | undefined | false;
};

export function useGuestInput({ attendees, onChange }: GuestList): GuestInput {
    const { user } = useAuth();
    const withGuest = ({ email, displayName }: { email: string; displayName?: string }): Attendee[] => [
        ...attendees,
        { email, name: displayName, status: 'pending', role: 'required' },
    ];
    const input = useContactInput({
        listed: attendees.map((a) => a.email),
        onAdd: (contact) => {
            if (contact.email === user?.email?.toLowerCase()) return 'You cannot invite yourself';
            onChange(withGuest(contact));
        },
    });
    return {
        ...input,
        commitGuests: () => {
            const typed = input.commitTyped();
            if ('refused' in typed) return false;
            return typed.added && withGuest(typed.added);
        },
    };
}

export function AttendeeEditor({ attendees, onChange, input }: GuestList & { input: GuestInput }) {
    return (
        <div className="space-y-2">
            <Label htmlFor="attendee-input" className="sr-only">
                Guests
            </Label>
            <ContactAddRow
                id="attendee-input"
                value={input.value}
                onChange={input.handleChange}
                onSubmit={input.submit}
                error={input.error}
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
