import { describe, expect, test } from 'bun:test';
import { LockManager, parseIfHeaderTokens } from '../../lib/webdav/locks';

describe('LockManager', () => {
    test('acquire returns a urn:uuid token', () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(lock.token).toMatch(/^urn:uuid:/);
    });

    test('second acquire by different user throws 423', () => {
        const m = new LockManager();
        m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(() => m.acquire({ pathId: 'p1', depth: 0, userId: 'u2' })).toThrow(/Locked/);
    });

    test('same user can re-acquire on the same path', () => {
        const m = new LockManager();
        m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        const second = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(second.token).toMatch(/^urn:uuid:/);
        expect(m.listForPath('p1')).toHaveLength(2);
    });

    test('refresh extends expiration', () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1', ttlMs: 1_000 });
        const before = lock.expiresAt;
        const refreshed = m.refresh(lock.token, 60_000);
        expect(refreshed).not.toBeNull();
        expect(refreshed!.expiresAt).toBeGreaterThan(before);
    });

    test('refresh returns null for expired lock', async () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1', ttlMs: 1 });
        await new Promise((r) => setTimeout(r, 5));
        expect(m.refresh(lock.token)).toBeNull();
    });

    test('release removes the lock', () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(m.release(lock.token)).toBe(true);
        expect(m.listForPath('p1')).toHaveLength(0);
        expect(m.release(lock.token)).toBe(false);
    });

    test('expired locks gc out of listForPath', async () => {
        const m = new LockManager();
        m.acquire({ pathId: 'p1', depth: 0, userId: 'u1', ttlMs: 1 });
        await new Promise((r) => setTimeout(r, 5));
        expect(m.listForPath('p1')).toHaveLength(0);
    });

    test('isWriteAllowed: no locks → true', () => {
        const m = new LockManager();
        expect(m.isWriteAllowed('p1', null, 'u1')).toBe(true);
    });

    test('isWriteAllowed: holder with matching token → true', () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u1')).toBe(true);
    });

    test('isWriteAllowed: holder without token → false', () => {
        const m = new LockManager();
        m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(m.isWriteAllowed('p1', null, 'u1')).toBe(false);
    });

    test('isWriteAllowed: different user even with token → false', () => {
        const m = new LockManager();
        const lock = m.acquire({ pathId: 'p1', depth: 0, userId: 'u1' });
        expect(m.isWriteAllowed('p1', `<${lock.token}>`, 'u2')).toBe(false);
    });

    test('parseIfHeaderTokens extracts angle-bracketed tokens', () => {
        expect(parseIfHeaderTokens('<urn:uuid:abc> (<urn:uuid:def>)')).toEqual(['urn:uuid:abc', 'urn:uuid:def']);
        expect(parseIfHeaderTokens(null)).toEqual([]);
        expect(parseIfHeaderTokens('')).toEqual([]);
    });
});
