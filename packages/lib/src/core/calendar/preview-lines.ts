import type { ImipMethod } from '../../types/calendar';

// What a file's own METHOD makes it: the banner a quick look shows above the events, so an invitation
// reads as one before a single detail is read.
export const ICS_METHOD_LABEL: Record<ImipMethod, string> = {
    REQUEST: 'Calendar invitation',
    REPLY: 'Calendar RSVP response',
    CANCEL: 'Calendar cancellation',
};
