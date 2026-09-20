import type { ImipMethod } from '../../types/calendar';

// The counted line an `.ics` preview ends on when the file holds more events than the payload lists.
export function remainingEventsLine(remaining: number): string {
    return `and ${remaining} more event${remaining === 1 ? '' : 's'}`;
}

// The counted line an event's guest list ends on when the event holds more guests than the payload lists.
export function remainingGuestsLine(remaining: number): string {
    return `and ${remaining} more guest${remaining === 1 ? '' : 's'}`;
}

// What a file's own METHOD makes it: the banner a quick look shows above the events, so an invitation
// reads as one before a single detail is read.
export const ICS_METHOD_LABEL: Record<ImipMethod, string> = {
    REQUEST: 'Calendar invitation',
    REPLY: 'Calendar RSVP response',
    CANCEL: 'Calendar cancellation',
};
