import { describe, expect, test } from 'bun:test';
import type { AddressObject } from '@workspace/lib/types/mail';
import { isInternalAddress } from '../lib/config/server-config';
import { canonicalizeRecipients, MAX_SEND_RECIPIENTS } from '../lib/mail/recipients';

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

const addr = (value: { name?: string; address?: string; group?: unknown }[]) =>
    ({ value, html: '', text: '' }) as AddressObject;

describe('canonicalizeRecipients', () => {
    test('flattens nested RFC 2822 groups', () => {
        const out = canonicalizeRecipients({
            to: addr([
                {
                    name: 'Team',
                    group: [
                        { name: 'A', address: 'a@x.com' },
                        { name: '', group: [{ name: 'B', address: 'b@x.com' }] },
                    ],
                },
            ]),
        });
        expect(out.map((r) => r.address).sort()).toEqual(['a@x.com', 'b@x.com']);
    });
    test('drops entries with no address', () => {
        const out = canonicalizeRecipients({
            to: addr([{ name: 'No Address' }, { name: '', address: 'a@x.com' }]),
        });
        expect(out).toEqual([{ name: '', address: 'a@x.com', field: 'to' }]);
    });
    test('dedupes case-insensitively with to > cc > bcc precedence', () => {
        const out = canonicalizeRecipients({
            to: addr([{ name: '', address: 'A@x.com' }]),
            cc: addr([
                { name: '', address: 'a@X.com' },
                { name: '', address: 'c@x.com' },
            ]),
            bcc: addr([
                { name: '', address: 'C@x.com' },
                { name: '', address: 'd@x.com' },
            ]),
        });
        expect(out).toEqual([
            { name: '', address: 'A@x.com', field: 'to' },
            { name: '', address: 'c@x.com', field: 'cc' },
            { name: '', address: 'd@x.com', field: 'bcc' },
        ]);
    });
    test('rejects invalid addresses with 400', () => {
        expect(() => canonicalizeRecipients({ to: addr([{ name: '', address: 'not-an-email' }]) })).toThrow(
            'Invalid recipient',
        );
    });
    test('accepts dotless domains like @localhost', () => {
        const out = canonicalizeRecipients({ to: addr([{ name: '', address: 'dev@localhost' }]) });
        expect(out).toEqual([{ name: '', address: 'dev@localhost', field: 'to' }]);
    });
    test('rejects more than MAX_SEND_RECIPIENTS with 400', () => {
        const many = Array.from({ length: MAX_SEND_RECIPIENTS + 1 }, (_, i) => ({ name: '', address: `u${i}@x.com` }));
        expect(() => canonicalizeRecipients({ to: addr(many) })).toThrow('at most');
    });
});
