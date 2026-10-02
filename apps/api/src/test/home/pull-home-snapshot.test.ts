import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as snapshotModule from '../../lib/backup/snapshot-home';
import { atHome, evictHome, getHome, touchHomeIfLoaded } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { BACKUP_RELEASE_MS, pullHomeSnapshot } from '../../lib/home/home-relay';
import { createTestUser, getTestContext } from '../setup';

const snapshotHome = snapshotModule.snapshotHome;
// Past the release, well inside the five-minute idle of a user home.
const LONG_AFTER_RELEASE_MS = BACKUP_RELEASE_MS + 60_000;
const USER_IDLE_MS = 5 * 60_000;

// A backup boots a home it found asleep only for as long as its capture, and never takes one away
// from a user who opened it meanwhile: it hands the home a short idle instead of evicting it.
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

    test('a home it booted and nobody opened goes after the short release idle', async () => {
        await evictHome(ownerId);
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});
        expect(atHome(ownerId)).toBe(true);

        jest.advanceTimersByTime(BACKUP_RELEASE_MS - 1);
        expect(atHome(ownerId)).toBe(true);
        jest.advanceTimersByTime(2);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a user who opens the home mid-capture keeps it, sockets and all, as long as their keepalive ticks', async () => {
        await evictHome(ownerId);
        let opened: Home | undefined;
        captureThenFakeTimers(async () => {
            opened = await getHome(ownerId);
        });
        await pullHomeSnapshot(ownerId, targetDir(), {});
        expect(opened).toBeDefined();
        expect(atHome(ownerId)).toBe(true);
        expect(opened!.destructing).toBe(false);

        // The keepalive re-arms the full idle, not the release one.
        jest.advanceTimersByTime(15_000);
        touchHomeIfLoaded(ownerId);
        jest.advanceTimersByTime(LONG_AFTER_RELEASE_MS);
        expect(atHome(ownerId)).toBe(true);
        expect(opened!.destructing).toBe(false);
        expect(await getHome(ownerId)).toBe(opened!);
    });

    test('a request that reaches the home mid-capture keeps the full idle, with no keepalive after it', async () => {
        await evictHome(ownerId);
        let opened: Home | undefined;
        captureThenFakeTimers(async () => {
            opened = await getHome(ownerId);
        });
        await pullHomeSnapshot(ownerId, targetDir(), {});

        jest.advanceTimersByTime(LONG_AFTER_RELEASE_MS);
        expect(atHome(ownerId)).toBe(true);
        expect(opened!.destructing).toBe(false);
        jest.advanceTimersByTime(USER_IDLE_MS);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a home that was tearing down when the capture started counts as asleep: its successor goes after the release idle', async () => {
        const going = (await getHome(ownerId)).shutdown();
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});
        await going;
        expect(atHome(ownerId)).toBe(true);

        jest.advanceTimersByTime(BACKUP_RELEASE_MS + 1);
        await waitForEviction();
        expect(atHome(ownerId)).toBe(false);
    });

    test('a home that was open before the capture keeps its full idle', async () => {
        const open = await getHome(ownerId);
        captureThenFakeTimers();
        await pullHomeSnapshot(ownerId, targetDir(), {});

        jest.advanceTimersByTime(LONG_AFTER_RELEASE_MS);
        expect(atHome(ownerId)).toBe(true);
        expect(open.destructing).toBe(false);
    });

    test('a capture that outlasts the idle, with no file to tick on, keeps the home it reads', async () => {
        await getHome(ownerId);
        jest.useFakeTimers();
        let destructing: boolean | undefined;
        spies.push(
            spyOn(snapshotModule, 'snapshotHome').mockImplementation(async (home, dir, options) => {
                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                destructing = home.destructing;
                return snapshotHome(home, dir, options);
            }),
        );
        await pullHomeSnapshot(ownerId, targetDir(), {});
        expect(destructing).toBe(false);
    });
});
