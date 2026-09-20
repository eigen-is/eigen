import { describe, expect, test } from 'bun:test';
import { ICS_METHOD_LABEL, remainingEventsLine } from '../../../core/calendar/preview-lines';
import { IMIP_METHODS } from '../../../types/calendar';

describe('remainingEventsLine', () => {
    test('counts the events the payload does not list', () => {
        expect(remainingEventsLine(1)).toBe('and 1 more event');
        expect(remainingEventsLine(42)).toBe('and 42 more events');
    });
});

describe('ICS_METHOD_LABEL', () => {
    test('names every method a file can declare', () => {
        for (const method of IMIP_METHODS) {
            expect(ICS_METHOD_LABEL[method].length).toBeGreaterThan(0);
        }
        expect(ICS_METHOD_LABEL.REQUEST).toBe('Calendar invitation');
        expect(ICS_METHOD_LABEL.CANCEL).toBe('Calendar cancellation');
        expect(ICS_METHOD_LABEL.REPLY).toBe('Calendar RSVP response');
    });
});
