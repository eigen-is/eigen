// Saves an event a drag dropped in a calendar view, such as the time grid or the month. A view mounts it for one drop,
// bound to the event's owner as Edit event is. A series first asks which events move, and an event with guests asks
// before its new time is sent to them; a cancel at either puts the event back. A drop with nothing to ask saves at
// once. A refused save reloads and toasts through the save's own error path, and an open question stays for a retry.

import { rethrowUntoasted } from '@workspace/lib/api-error';
import { useAuth } from '@workspace/lib/auth';
import type { EventTimes } from '@workspace/lib/calendar';
import { rescheduleScopes, useSaveOccurrence } from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, RecurrenceScope } from '@workspace/lib/types/calendar';
import { useHeldEtag } from '@workspace/lib/use-held-etag';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { useEffect, useEffectEvent, useState } from 'react';
import { RecurringActionDialog } from './recurring-action-dialog';

export type EventDropHostProps = {
    // As the list has it now, so a retry answers to the reloaded etag.
    event: CalendarEventOccurrence;
    moved: EventTimes;
    ownerId: string;
    onDone: () => void;
};

export function EventDropHost({ event, moved, ownerId, onDone }: EventDropHostProps) {
    const { user } = useAuth();
    const held = useHeldEtag(event.etag, false);
    const save = useSaveOccurrence(ownerId, held);
    // Asked of the event as it was dropped, so a reload under an open question doesn't change the question. The server
    // tells every guest but the one saving and the calendar's owner, the organizer an event with guests names. A team has
    // no address, so on its calendar the organizer is the member who created the event, and the question skips them too.
    const [asks] = useState(() => {
        const selves = new Set([user?.email, event.data?.organizer?.email].map((email) => email?.toLowerCase()));
        return {
            scopes: rescheduleScopes(event, moved),
            guests: (event.data?.attendees ?? []).some((guest) => !selves.has(guest.email.toLowerCase())),
        };
    });
    const [scope, setScope] = useState<RecurrenceScope | null>(null);

    // The absolute slot it was dropped on, so a retry after a reload lands there too.
    const write = (picked: RecurrenceScope) =>
        held.saveHeld(async () => {
            await save({ occurrence: event, scope: picked, edited: { ...event, ...moved } });
        });

    const saveAtOnce = useEffectEvent(() => {
        if (asks.scopes.length > 0 || asks.guests) return;
        void write('all').catch(rethrowUntoasted).finally(onDone);
    });
    useEffect(() => {
        saveAtOnce();
    }, []);

    const close = (open: boolean) => {
        if (!open) onDone();
    };

    return (
        <>
            <RecurringActionDialog
                open={asks.scopes.length > 0 && !scope}
                onOpenChange={close}
                title="Edit recurring event"
                options={asks.scopes}
                onConfirm={async (picked) => {
                    if (!asks.guests) {
                        await write(picked);
                        return;
                    }
                    setScope(picked);
                    return false;
                }}
            />
            <ConfirmDialog
                open={asks.guests && (asks.scopes.length === 0 || !!scope)}
                onOpenChange={close}
                title="Send update emails to guests?"
                description="Your guests will get the event's new time."
                confirmText="Send"
                onConfirm={() => write(scope ?? 'all')}
            />
        </>
    );
}
