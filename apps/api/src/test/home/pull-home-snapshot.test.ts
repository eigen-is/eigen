import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as snapshotModule from '../../lib/backup/snapshot-home';
import { atHome, evictHome, getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { pullHomeSnapshot } from '../../lib/home/home-relay';
import { createTestUser, getTestContext } from '../setup';

const snapshotHome = snapshotModule.snapshotHome;
const USER_IDLE_MS = 5 * 60_000;

// A backup opens a home without counting as a request and holds it while it captures, like any other
// holder. So a home nobody requested closes when the capture lets go, and a request keeps a home open
// until that request is its idle time ago. The backup never closes a home by force.
describe('pullHomeSnapshot', () => {
    let ownerId: string;
    const dirs: string[] = [];
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        await getTestContext();
        ownerId = (await createTestUser(`pull-snapshot-${Date.now()}@test.eigen.is`, 'testpassword123', 'Puller')).id;
        await getHome(ownerId);
    });

    afterEach(() => {
        jest.useRealTimers();
        for (const spy of spies.splice(0)) spy.mockRestore();
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function targetDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'pull-snapshot-'));
        dirs.push(dir);
        return dir;
    }

    // The real capture, then fake timers from there on: the idle the capture ends with is the one
    // the test drives.
    function captureThenFakeTimers(during?: () => Promise<void>): void {
        spies.push(
            spyOn(snapshotModule, 'snapshotHome').mockImplementation(async (home, dir, options) => {
                await during?.();
                const manifest = await snapshotHome(home, dir, options);
                jest.useFakeTimers();
                return manifest;
            }),
        );
    }

    async function waitForEviction(): Promise<void> {
        jest.useRealTimers();
        for (let attempt = 0; attempt < 100 && atHome(ownerId); attempt++) await Bun.sleep(20);
    }

    // Moves the fake clock to a moment, firing every timer due by then.
    function advanceTo(time: number): void {
        jest.advanceTimersByTime(time - Date.now());
    }

    // The request's time on the real clock lies between the two, and the fake clock goes on from there.
    async function request(): Promise<{ home: Home; after: number; before: number }> {
        const before = Date.now();
        const home = await getHome(ownerId);
        return { home, before, after: Date.now() };
    }

    test('a home nobody requested closes when the capture lets go', async () => {
        await evictHome(ownerId);
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});
        expect(atHome(ownerId)).toBe(true);

        jest.advanceTimersByTime(1);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a request during the capture keeps the home open until that request is its idle time ago', async () => {
        await evictHome(ownerId);
        let requested: Awaited<ReturnType<typeof request>> | undefined;
        captureThenFakeTimers(async () => {
            requested = await request();
        });
        await pullHomeSnapshot(ownerId, targetDir(), {});
        if (!requested) throw new Error('the capture made no request');

        advanceTo(requested.before + USER_IDLE_MS - 1);
        expect(requested.home.closing).toBe(false);
        advanceTo(requested.after + USER_IDLE_MS + 1);
        expect(requested.home.closing).toBe(true);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a request before the capture keeps the home open until that request is its idle time ago', async () => {
        await evictHome(ownerId);
        const requested = await request();
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});

        advanceTo(requested.before + USER_IDLE_MS - 1);
        expect(requested.home.closing).toBe(false);
        advanceTo(requested.after + USER_IDLE_MS + 1);
        expect(requested.home.closing).toBe(true);
    });

    test('a user who connects mid-capture keeps the home while the connection holds it, and no longer', async () => {
        await evictHome(ownerId);
        let opened: Home | undefined;
        let releaseConnection: (() => void) | undefined;
        captureThenFakeTimers(async () => {
            opened = await getHome(ownerId);
            // What an event stream or a collab socket takes when it opens.
            releaseConnection = opened.hold();
        });
        await pullHomeSnapshot(ownerId, targetDir(), {});
        if (!opened || !releaseConnection) throw new Error('the capture made no connection');

        jest.advanceTimersByTime(2 * USER_IDLE_MS);
        expect(opened.closing).toBe(false);

        // The user's last request is long ago, so the connection's release closes the home at once.
        releaseConnection();
        jest.advanceTimersByTime(1);
        expect(opened.closing).toBe(true);
        await waitForEviction();
    });

    test('a home that was tearing down when the capture started counts as unrequested: its successor closes after the capture', async () => {
        const going = (await getHome(ownerId)).close();
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});
        await going;
        expect(atHome(ownerId)).toBe(true);

        jest.advanceTimersByTime(1);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a capture that outlasts the idle, with no file to tick on, keeps the home it reads', async () => {
        await getHome(ownerId);
        jest.useFakeTimers();
        let closing: boolean | undefined;
        spies.push(
            spyOn(snapshotModule, 'snapshotHome').mockImplementation(async (home, dir, options) => {
                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                closing = home.closing;
                return snapshotHome(home, dir, options);
            }),
        );
        await pullHomeSnapshot(ownerId, targetDir(), {});
        expect(closing).toBe(false);
    });
});
