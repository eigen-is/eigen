// The guest list of the event dialogs: a field that adds a guest by address or from the contacts it suggests, and the
// guests below it with their reply and a button that removes one. A typed address takes the name of the user's contact
// for it, if there is one. Inviting yourself or a guest already listed is refused under the field. The dialog owns the
// list and, through useGuestInput, the field's text, so its Save counts typed text as a change and adds it first.

import type { Attendee } from '@workspace/lib/types/calendar';
import { Badge } from '@workspace/ui/components/badge';
import { ATTENDEE_STATUS_ICON, ATTENDEE_STATUS_LABEL } from '@workspace/ui/components/calendar';
import { ContactAddRow, useContactInput } from '@workspace/ui/components/contacts';
import { Label } from '@workspace/ui/components/label';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { UserItem } from '@workspace/ui/components/user';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { X as XIcon } from 'lucide-react';
import { useRef } from 'react';

type GuestList = {
    attendees: readonly Attendee[];
    onChange: (attendees: Attendee[]) => void;
};

type GuestInput = ReturnType<typeof useContactInput> & {
    // The guests with the typed one added, or nothing when the field refuses them and says why.
    commitGuests: () => Attendee[] | undefined;
};

export function useGuestInput({
    attendees,
    onChange,
    currentUserEmail,
}: GuestList & { currentUserEmail?: string }): GuestInput {
    // commitTyped adds through onAdd before a render shows the guest, so a save takes the list onAdd built.
    const built = useRef<Attendee[]>(null);
    const input = useContactInput({
        listed: attendees.map((a) => a.email),
        onAdd: ({ email, displayName }) => {
            if (email === currentUserEmail?.toLowerCase()) return 'You cannot invite yourself';
            built.current = [...attendees, { email, name: displayName, status: 'pending', role: 'required' }];
            onChange(built.current);
        },
    });
    return {
        ...input,
        commitGuests: () => {
            built.current = null;
            if (input.commitTyped()) return undefined;
            return built.current ?? [...attendees];
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
