import { describe, expect, test } from 'bun:test';
import { isClickableNotification } from '../../../core/notification/resolve-link';

describe('isClickableNotification', () => {
    test('a share opens what was shared', () => {
        expect(isClickableNotification('calendar-share')).toBe(true);
    });

    test('an unshare has nothing to open', () => {
        expect(isClickableNotification('calendar-unshare')).toBe(false);
    });
});
