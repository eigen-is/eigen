import { describe, expect, test } from 'bun:test';
import type { AddressObject, EmailAddress } from '@workspace/lib/types/mail';
import { canonicalRecipients, flattenAddresses } from './addresses';

function field(...value: EmailAddress[]): AddressObject {
    return { value, html: '', text: '' };
}

describe('flattenAddresses', () => {
    test('returns an empty list for a missing field', () => {
        expect(flattenAddresses(undefined)).toEqual([]);
    });

    test('keeps a flat list in order', () => {
        const flat = flattenAddresses([
            { name: 'Alice', address: 'alice@test.eigen.is' },
            { name: 'Bob', address: 'bob@test.eigen.is' },
        ]);
        expect(flat).toEqual([
            { name: 'Alice', address: 'alice@test.eigen.is' },
            { name: 'Bob', address: 'bob@test.eigen.is' },
        ]);
    });

    test('expands a group into its members and drops the bare container', () => {
        const flat = flattenAddresses([
            {
                name: 'Team',
                group: [
                    { name: 'Alice', address: 'alice@test.eigen.is' },
                    { name: 'Bob', address: 'bob@test.eigen.is' },
                ],
            },
        ]);
        expect(flat).toEqual([
            { name: 'Alice', address: 'alice@test.eigen.is' },
            { name: 'Bob', address: 'bob@test.eigen.is' },
        ]);
    });

    test('expands nested groups', () => {
        const flat = flattenAddresses([
            {
                name: 'Everyone',
                group: [
                    { name: 'Team', group: [{ name: 'Alice', address: 'alice@test.eigen.is' }] },
                    { name: 'Bob', address: 'bob@test.eigen.is' },
                ],
            },
        ]);
        expect(flat.map((a) => a.address)).toEqual(['alice@test.eigen.is', 'bob@test.eigen.is']);
    });

    test('defaults a missing name to an empty string', () => {
        expect(flattenAddresses([{ name: '', address: 'alice@test.eigen.is' }])).toEqual([
            { name: '', address: 'alice@test.eigen.is' },
        ]);
    });
});

describe('canonicalRecipients', () => {
    test('orders to > cc > bcc', () => {
        const recipients = canonicalRecipients({
            to: field({ name: 'Alice', address: 'alice@test.eigen.is' }),
            cc: field({ name: 'Bob', address: 'bob@test.eigen.is' }),
            bcc: field({ name: 'Carol', address: 'carol@test.eigen.is' }),
        });
        expect(recipients).toEqual([
            { name: 'Alice', address: 'alice@test.eigen.is', field: 'to' },
            { name: 'Bob', address: 'bob@test.eigen.is', field: 'cc' },
            { name: 'Carol', address: 'carol@test.eigen.is', field: 'bcc' },
        ]);
    });

    test('dedupes case-insensitively, first field wins', () => {
        const recipients = canonicalRecipients({
            to: field({ name: 'Alice', address: 'alice@test.eigen.is' }),
            cc: field({ name: 'Alice dupe', address: 'ALICE@test.eigen.is' }),
            bcc: field({ name: 'Alice bcc', address: 'Alice@Test.Eigen.is' }),
        });
        expect(recipients).toEqual([{ name: 'Alice', address: 'alice@test.eigen.is', field: 'to' }]);
    });

    test('flattens groups before deduping', () => {
        const recipients = canonicalRecipients({
            to: field({ name: 'Team', group: [{ name: 'Alice', address: 'alice@test.eigen.is' }] }),
            cc: field({ name: 'Alice', address: 'alice@test.eigen.is' }, { name: 'Bob', address: 'bob@test.eigen.is' }),
        });
        expect(recipients).toEqual([
            { name: 'Alice', address: 'alice@test.eigen.is', field: 'to' },
            { name: 'Bob', address: 'bob@test.eigen.is', field: 'cc' },
        ]);
    });
});
