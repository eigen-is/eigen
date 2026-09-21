import { describe, expect, test } from 'bun:test';
import { ICS_METHOD_LABEL } from '../../../core/calendar/preview-lines';

// A METHOD belongs to the file, not to one of its events: the banner is what says so, and it is the one
// place an invitation, a response and a cancellation are named.
describe('ICS_METHOD_LABEL', () => {
    test('names each method a quick look can meet', () => {
        expect(ICS_METHOD_LABEL.REQUEST).toBe('Calendar invitation');
        expect(ICS_METHOD_LABEL.REPLY).toBe('Calendar RSVP response');
        expect(ICS_METHOD_LABEL.CANCEL).toBe('Calendar cancellation');
    });
});
