import { describe, expect, test } from 'bun:test';
import { normalizeTimezone } from '../../lib/calendar/timezone';

// Every stored timezone, every parsed TZID and every serialized VEVENT passes through here, and one
// calendar file names the same handful of zones on every event it holds. The TZIDs are a stranger's
// strings, so whatever remembers an answer stays bounded and keeps answering correctly when it fills.
describe('normalizeTimezone', () => {
    test('an IANA zone is kept and anything else degrades to null', () => {
        expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
        expect(normalizeTimezone('W. Europe Standard Time')).toBeNull();
        expect(normalizeTimezone(null)).toBeNull();
        expect(normalizeTimezone('')).toBeNull();
    });

    test('a file naming hundreds of zones still answers each of them correctly', () => {
        for (let i = 0; i < 500; i++) {
            expect(normalizeTimezone(`Not/A_Zone_${i}`)).toBeNull();
            expect(normalizeTimezone('Pacific/Auckland')).toBe('Pacific/Auckland');
        }

        expect(normalizeTimezone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
        expect(normalizeTimezone('W. Europe Standard Time')).toBeNull();
    });

    test('the zones one file repeats cost one formatter each', () => {
        const zones = ['Europe/Amsterdam', 'America/New_York', 'Pacific/Auckland', 'W. Europe Standard Time'];

        const startedAt = performance.now();
        for (let i = 0; i < 50_000; i++) normalizeTimezone(zones[i % zones.length]);

        expect(performance.now() - startedAt).toBeLessThan(300);
    });
});
