import { describe, expect, test } from 'bun:test';
import { NO_CONTROL_PATTERN } from '@workspace/lib/validation';
import { isUsableName, validateName } from '../../lib/mount/names';

// A name validateName accepts is one the backup's path check (NO_CONTROL_PATTERN) accepts too, or
// the drive holds a file no backup of its home can archive.
describe('names refuse what the backup refuses', () => {
    const noControl = new RegExp(NO_CONTROL_PATTERN);

    test.each(['a\x00b', 'a\x01b', 'a\x1fb', 'a\x7fb'])('refuses %j', (name) => {
        expect(noControl.test(name)).toBe(false);
        expect(isUsableName(name)).toBe(false);
        expect(() => validateName(name)).toThrow('Invalid file or folder name');
    });

    test('accepts a name with no control character', () => {
        expect(validateName('Report ~ 2026.pdf')).toBe('Report ~ 2026.pdf');
    });
});
