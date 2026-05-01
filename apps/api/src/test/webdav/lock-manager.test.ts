import { describe, expect, test } from 'bun:test';
import { LockManager, parseIfHeaderTokens } from '../../lib/drive/lock-manager';

const exclusive = (overrides: Partial<Parameters<LockManager['acquire']>[0]> = {}) => ({
    pathId: 'p1',
    depth: 0 as const,
    scope: 'exclusive' as const,
    userId: 'u1',
    ...overrides,
});

describe('LockManager', () => {
    test('acquire returns a urn:uuid token', () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive());
        expect(lock.token).toMatch(/^urn:uuid:/);
    });

    test('second acquire without an authorizing If token throws 423', () => {
        const m = new LockManager();
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive({ userId: 'u2' }))).toThrow(/Locked/);
    });

    test('second acquire by same user without If token still throws 423', () => {
        // RFC 4918 §7.5: principal identity doesn't matter; the requester must
        // present the existing token.
        const m = new LockManager();
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive())).toThrow(/Locked/);
    });

    test('shared locks may coexist', () => {
        const m = new LockManager();
        m.acquire(exclusive({ scope: 'shared' }));
        const second = m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(second.token).toMatch(/^urn:uuid:/);
        expect(m.listForPath('p1')).toHaveLength(2);
    });

    test('exclusive blocks new shared lock', () => {
        const m = new LockManager();
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive({ scope: 'shared', userId: 'u2' }))).toThrow(/Locked/);
    });

    test('refresh extends expiration', () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive({ ttlMs: 1_000 }));
        const before = lock.expiresAt;
        const refreshed = m.refresh(lock.token, 60_000);
        expect(refreshed).not.toBeNull();
        expect(refreshed!.expiresAt).toBeGreaterThan(before);
    });

    test('refresh returns null for expired lock', async () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive({ ttlMs: 1 }));
        await new Promise((r) => setTimeout(r, 5));
        expect(m.refresh(lock.token)).toBeNull();
    });

    test('release removes the lock', () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive());
        expect(m.release(lock.token)).toBe(true);
        expect(m.listForPath('p1')).toHaveLength(0);
        expect(m.release(lock.token)).toBe(false);
    });

    test('expired locks gc out of listForPath', async () => {
        const m = new LockManager();
        m.acquire(exclusive({ ttlMs: 1 }));
        await new Promise((r) => setTimeout(r, 5));
        expect(m.listForPath('p1')).toHaveLength(0);
    });

    test('isWriteAllowed: no locks → true', () => {
        const m = new LockManager();
        expect(m.isWriteAllowed('p1', null, 'u1')).toBe(true);
    });

    test('isWriteAllowed: holder with matching token → true', () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u1')).toBe(true);
    });

    test('isWriteAllowed: holder without token → false', () => {
        const m = new LockManager();
        m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', null, 'u1')).toBe(false);
    });

    test('isWriteAllowed: different user even with token → false', () => {
        const m = new LockManager();
        const lock = m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u2')).toBe(false);
    });

    test('parseIfHeaderTokens extracts angle-bracketed tokens', () => {
        expect(parseIfHeaderTokens('<urn:uuid:abc> (<urn:uuid:def>)')).toEqual(['urn:uuid:abc', 'urn:uuid:def']);
        expect(parseIfHeaderTokens(null)).toEqual([]);
        expect(parseIfHeaderTokens('')).toEqual([]);
    });

    test('acquire blocks descendant lock when ancestor holds depth-infinity exclusive', () => {
        // RFC 4918 §6.2: a depth-infinity lock on a collection covers every member.
        // Acquiring a new lock on a descendant must be rejected without an authorizing token.
        const m = new LockManager();
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity' }));
        expect(() => m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }))).toThrow(
            /Locked/,
        );
    });

    test('acquire allows descendant lock when ancestor token is presented', () => {
        const m = new LockManager();
        const parent = m.acquire(exclusive({ pathId: 'parent', depth: 'infinity' }));
        const child = m.acquire(
            exclusive({ pathId: 'child', ancestorPathIds: ['parent'], ifHeader: `<${parent.token}>` }),
        );
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire ignores depth=0 ancestor lock', () => {
        // A depth-0 lock covers only its own resource, not descendants.
        const m = new LockManager();
        m.acquire(exclusive({ pathId: 'parent', depth: 0 }));
        const child = m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }));
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire allows shared descendant under shared depth-infinity ancestor', () => {
        const m = new LockManager();
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity', scope: 'shared' }));
        const child = m.acquire(
            exclusive({ pathId: 'child', userId: 'u2', scope: 'shared', ancestorPathIds: ['parent'] }),
        );
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire blocks exclusive descendant under shared depth-infinity ancestor', () => {
        const m = new LockManager();
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity', scope: 'shared' }));
        expect(() => m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }))).toThrow(
            /Locked/,
        );
    });
});
