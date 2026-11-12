import { describe, expect, test } from 'bun:test';
import { LOCK_DEFAULT_TTL_MS, LockManager, parseIfHeaderTokens } from '../../lib/drive/lock-manager';

const exclusive = (overrides: Partial<Parameters<LockManager['acquire']>[0]> = {}) => ({
    pathId: 'p1',
    depth: 0 as const,
    scope: 'exclusive' as const,
    userId: 'u1',
    ttlMs: LOCK_DEFAULT_TTL_MS,
    ifHeader: null,
    ancestorPathIds: [],
    descendantPathIds: [],
    ...overrides,
});

// These tests pin the lock rules. The hold of the Home is pinned in lock-home-hold.test.ts.
const noHold = () => () => {};

describe('LockManager', () => {
    test('acquire returns a urn:uuid token', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive());
        expect(lock.token).toMatch(/^urn:uuid:/);
    });

    test('second acquire without an authorizing If token throws 423', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive({ userId: 'u2' }))).toThrow(/Locked/);
    });

    test('second acquire by same user without If token still throws 423', () => {
        // RFC 4918 §7.5: owning the lock is not enough; the owner must present its token too.
        const m = new LockManager(noHold);
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive())).toThrow(/Locked/);
    });

    test('shared locks may coexist', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ scope: 'shared' }));
        const second = m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(second.token).toMatch(/^urn:uuid:/);
        expect(m.listForPath('p1')).toHaveLength(2);
    });

    test('exclusive blocks new shared lock', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive());
        expect(() => m.acquire(exclusive({ scope: 'shared', userId: 'u2' }))).toThrow(/Locked/);
    });

    test('refresh extends expiration', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive({ ttlMs: 1_000 }));
        const before = lock.expiresAt;
        const refreshed = m.refresh('p1', 'u1', `<${lock.token}>`, 60_000);
        expect(refreshed?.expiresAt).toBeGreaterThan(before);
    });

    test('refresh: another user with the token, or the owner on another path, extends nothing', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive({ ttlMs: 1_000 }));
        const before = lock.expiresAt;
        expect(m.refresh('p1', 'u2', `<${lock.token}>`, 60_000)).toBeUndefined();
        expect(m.refresh('p2', 'u1', `<${lock.token}>`, 60_000)).toBeUndefined();
        expect(lock.expiresAt).toBe(before);
    });

    test('refresh returns null for expired lock', async () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive({ ttlMs: 1 }));
        await new Promise((r) => setTimeout(r, 5));
        expect(m.refresh('p1', 'u1', `<${lock.token}>`, LOCK_DEFAULT_TTL_MS)).toBeUndefined();
    });

    test('release removes the lock', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive());
        m.release(lock.token);
        expect(m.listForPath('p1')).toHaveLength(0);
    });

    test('expired locks gc out of listForPath', async () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ ttlMs: 1 }));
        await new Promise((r) => setTimeout(r, 5));
        expect(m.listForPath('p1')).toHaveLength(0);
    });

    test('isWriteAllowed: no locks → true', () => {
        const m = new LockManager(noHold);
        expect(m.isWriteAllowed('p1', null, 'u1', [])).toBe(true);
    });

    test('isWriteAllowed: holder with matching token → true', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u1', [])).toBe(true);
    });

    test('isWriteAllowed: holder without token → false', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', null, 'u1', [])).toBe(false);
    });

    test('isWriteAllowed: different user even with token → false', () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive());
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u2', [])).toBe(false);
    });

    test("acquire: another user's token does not pass an exclusive lock", () => {
        const m = new LockManager(noHold);
        const lock = m.acquire(exclusive());
        expect(() => m.acquire(exclusive({ userId: 'u2', ifHeader: `<${lock.token}>` }))).toThrow(/Locked/);
        expect(m.listForPath('p1')).toHaveLength(1);
    });

    test("acquire: another user's token on a folder lock does not pass it for a child", () => {
        const m = new LockManager(noHold);
        const parent = m.acquire(exclusive({ pathId: 'parent', depth: 'infinity' }));
        const child = exclusive({
            pathId: 'child',
            userId: 'u2',
            ancestorPathIds: ['parent'],
            ifHeader: `<${parent.token}>`,
        });
        expect(() => m.acquire(child)).toThrow(/Locked/);
    });

    test('isWriteAllowed: one of two shared locks, with its own token → true', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ scope: 'shared' }));
        const own = m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(m.isWriteAllowed('p1', `<${own.token}>`, 'u2', [])).toBe(true);
    });

    test('isWriteAllowed: two shared locks, no token → false', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ scope: 'shared' }));
        m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(m.isWriteAllowed('p1', null, 'u2', [])).toBe(false);
    });

    test("isWriteAllowed: another user's shared token → false", () => {
        const m = new LockManager(noHold);
        const other = m.acquire(exclusive({ scope: 'shared' }));
        m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(m.isWriteAllowed('p1', `<${other.token}>`, 'u2', [])).toBe(false);
    });

    test("acquire: an own token does not pass another user's shared lock for an exclusive one", () => {
        const m = new LockManager(noHold);
        const own = m.acquire(exclusive({ scope: 'shared' }));
        m.acquire(exclusive({ scope: 'shared', userId: 'u2' }));
        expect(() => m.acquire(exclusive({ ifHeader: `<${own.token}>` }))).toThrow(/Locked/);
        expect(m.listForPath('p1')).toHaveLength(2);
    });

    test("acquire: a depth-infinity lock on a folder is refused over another user's lock below it", () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ pathId: 'child' }));
        const folder = exclusive({ pathId: 'parent', depth: 'infinity', userId: 'u2', descendantPathIds: ['child'] });
        expect(() => m.acquire(folder)).toThrow(/Locked/);
        expect(() => m.acquire({ ...folder, scope: 'shared' })).toThrow(/Locked/);
    });

    test('acquire: a depth-infinity lock on a folder passes an own lock below it with its token, and shared ones', () => {
        const m = new LockManager(noHold);
        const own = m.acquire(exclusive({ pathId: 'child' }));
        m.acquire(exclusive({ pathId: 'other', scope: 'shared', userId: 'u2' }));
        const folder = exclusive({ pathId: 'parent', depth: 'infinity', descendantPathIds: ['child', 'other'] });
        expect(() => m.acquire(folder)).toThrow(/Locked/);
        expect(() => m.acquire({ ...folder, ifHeader: `<${own.token}>` })).toThrow(/Locked/);
        const shared = m.acquire({ ...folder, scope: 'shared', ifHeader: `<${own.token}>` });
        expect(shared.token).toMatch(/^urn:uuid:/);
    });

    test('parseIfHeaderTokens extracts angle-bracketed tokens', () => {
        expect(parseIfHeaderTokens('<urn:uuid:abc> (<urn:uuid:def>)')).toEqual(['urn:uuid:abc', 'urn:uuid:def']);
        expect(parseIfHeaderTokens(null)).toEqual([]);
        expect(parseIfHeaderTokens('')).toEqual([]);
    });

    test('acquire blocks descendant lock when ancestor holds depth-infinity exclusive', () => {
        // RFC 4918 §6.2: a depth-infinity lock on a collection covers every member.
        // Acquiring a new lock on a descendant must be rejected without an authorizing token.
        const m = new LockManager(noHold);
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity' }));
        expect(() => m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }))).toThrow(
            /Locked/,
        );
    });

    test('acquire allows descendant lock when ancestor token is presented', () => {
        const m = new LockManager(noHold);
        const parent = m.acquire(exclusive({ pathId: 'parent', depth: 'infinity' }));
        const child = m.acquire(
            exclusive({ pathId: 'child', ancestorPathIds: ['parent'], ifHeader: `<${parent.token}>` }),
        );
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire ignores depth=0 ancestor lock', () => {
        // A depth-0 lock covers only its own resource, not descendants.
        const m = new LockManager(noHold);
        m.acquire(exclusive({ pathId: 'parent', depth: 0 }));
        const child = m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }));
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire allows shared descendant under shared depth-infinity ancestor', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity', scope: 'shared' }));
        const child = m.acquire(
            exclusive({ pathId: 'child', userId: 'u2', scope: 'shared', ancestorPathIds: ['parent'] }),
        );
        expect(child.token).toMatch(/^urn:uuid:/);
    });

    test('acquire blocks exclusive descendant under shared depth-infinity ancestor', () => {
        const m = new LockManager(noHold);
        m.acquire(exclusive({ pathId: 'parent', depth: 'infinity', scope: 'shared' }));
        expect(() => m.acquire(exclusive({ pathId: 'child', userId: 'u2', ancestorPathIds: ['parent'] }))).toThrow(
            /Locked/,
        );
    });
});
