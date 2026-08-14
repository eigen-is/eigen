import { describe, expect, test } from 'bun:test';
import { isInternalAddress } from '../lib/config/server-config';

// The preload runs setup.ts, which completes first-run setup with domain 'test.eigen.is' —
// that IS the mail domain in EVERY preloaded test run, unit-style included. Never 'localhost'.
describe('isInternalAddress', () => {
    test('matches the mail domain case-insensitively', () => {
        expect(isInternalAddress('alice@test.eigen.is')).toBe(true);
        expect(isInternalAddress('Alice@TEST.EIGEN.IS')).toBe(true);
        expect(isInternalAddress('bob@example.com')).toBe(false);
    });
    test('does not match without the @ boundary', () => {
        expect(isInternalAddress('bob@xtest.eigen.is')).toBe(false);
    });
});
