// A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
// or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
// builds the Home on first use. It stays loaded while it is used or held, such as by an open tab,
// and closes itself, databases included, after a few idle minutes. This base class owns that
// lifecycle; each kind of home decides which parts it has.

import * as path from 'node:path';
import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { time } from '../../utils/timing';
import type { Calendar } from '../calendar/calendar';
import { PATHS } from '../config/paths';
import type { ResolvedQuotas } from '../config/quota';
import { resolveUserQuotas } from '../config/quota';
import type { Contacts } from '../contacts/contacts';
import type { DatabaseConfig, JsonStore, ManagedDatabase, SchemaType } from '../core';
import { ApiError, LocalFilesystem, openLocalDatabase, STALE_TEMP_MAX_AGE_MS } from '../core';
import type { Drive } from '../drive';
import type { Mail } from '../mail/mail-domain';
import { createDefaultMountConfig, createMountConfig, DEFAULT_MOUNT_ID, readMountTotalSize } from '../mount/helpers';
import type { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';

export type HomeSettings = Pick<UserSettings, 'mounts'>;

export class Home {
    public readonly user: User;
    public readonly homeDir: string;
    public readonly fs: LocalFilesystem;
    public settings!: JsonStore<HomeSettings>;

    // Which parts exist depends on the kind of home. A part the home doesn't have stays undefined,
    // and its getter answers 404.
    protected _drive?: Drive;
    protected _contacts?: Contacts;
    protected _mail?: Mail;
    protected _calendar?: Calendar;
    protected _notifications?: NotificationCenter;

    protected idleMs = 1000 * 60 * 5;

    private idleTimer: Timer | undefined;
    private holds = 0;
    private initPromise: Promise<this> | null = null;
    private closePromise: Promise<void> | null = null;
    // Set before the close starts, so code that runs while the parts close already sees it.
    private _closing = false;
    // Runs once the close is done, to drop this home from the cache.
    private readonly onClosed: (() => void) | undefined;
    // What the holders asked to run when the close starts, such as ending an event stream.
    private readonly holderCloseCallbacks = new Set<() => void>();
    // The open of each database file under the home, in flight or done.
    private readonly managedDatabases = new Map<string, Promise<ManagedDatabase<SchemaType>>>();
    private readonly sseListeners = new Set<(event: SSEvent) => void>();

    public constructor(user: User, homeDir: string, onClosed?: () => void) {
        this.user = user;
        this.homeDir = homeDir;
        this.fs = new LocalFilesystem(homeDir);
        this.onClosed = onClosed;
    }

    public get drive(): Drive {
        this.touch();
        if (!this._drive) throw new ApiError(404, 'Drive not available');
        return this._drive;
    }

    public get contacts(): Contacts {
        this.touch();
        if (!this._contacts) throw new ApiError(404, 'Contacts not available');
        return this._contacts;
    }

    public get mail(): Mail {
        this.touch();
        if (!this._mail) throw new ApiError(404, 'Mail not available');
        return this._mail;
    }

    public get calendar(): Calendar {
        this.touch();
        if (!this._calendar) throw new ApiError(404, 'Calendar not available');
        return this._calendar;
    }

    public get notifications(): NotificationCenter {
        this.touch();
        if (!this._notifications) throw new ApiError(404, 'Notifications not available');
        return this._notifications;
    }

    public get hasCalendar(): boolean {
        return !!this._calendar;
    }

    public get closing(): boolean {
        return this._closing;
    }

    public init(): Promise<this> {
        return (this.initPromise ??= this.runInit());
    }

    private async runInit(): Promise<this> {
        try {
            // A crash between writing a settings file's staged copy and its rename leaves the copy behind.
            await this.fs
                .sweepAtomicTemps('.', STALE_TEMP_MAX_AGE_MS)
                .catch((err) => console.error(`[Home] Sweeping staged files failed for ${this.user.id}:`, err));
            await time('Home.init.settings', () => this.loadSettings());

            // allSettled waits for every part. Promise.all would return at the first failure while
            // the other parts are still opening databases and starting timers, and those would leak.
            const results = await Promise.allSettled([
                time('Home.init.drive', async () => this._drive?.init()),
                time('Home.init.contacts', async () => this._contacts?.init()),
                time('Home.init.mail', async () => this._mail?.init()),
                time('Home.init.calendar', async () => this._calendar?.init()),
                time('Home.init.notifications', async () => this._notifications?.init()),
            ]);
            const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failed) throw failed.reason;

            console.log(`[Home] Initialized for ${this.user.id}`);
            return this;
        } catch (err) {
            // A failed init leaves nothing open behind it.
            await this.close();
            throw err;
        }
    }

    // A kind of home may fill in missing settings here, before its parts read them.
    protected async loadSettings(): Promise<void> {
        await this.settings.load();
    }

    // Runs once, however often it is called: closing the same database files twice is unsafe.
    public close(): Promise<void> {
        if (!this.closePromise) {
            this._closing = true;
            clearTimeout(this.idleTimer);
            // Before the parts close, so a holder such as an event stream ends and its client reconnects to the
            // next home. One holder that fails must not stop the close or the other holders.
            for (const callback of this.holderCloseCallbacks) {
                try {
                    callback();
                } catch (err) {
                    console.error(`[Home] A holder failed to end for ${this.user.id}:`, err);
                }
            }
            this.holderCloseCallbacks.clear();
            this.closePromise = this.runClose();
        }
        return this.closePromise;
    }

    private async runClose(): Promise<void> {
        const logFailure = (part: string) => (err: unknown) =>
            console.error(`[Home] Failed to close ${part} for ${this.user.id}:`, err);

        // Each part closes its own databases. The second step only closes what is still open.
        await Promise.all([
            this._drive?.destruct().catch(logFailure('drive')),
            this._contacts?.destruct().catch(logFailure('contacts')),
            this._mail?.destruct().catch(logFailure('mail')),
            this._calendar?.destruct().catch(logFailure('calendar')),
            this._notifications?.destruct().catch(logFailure('notifications')),
        ]);
        await Promise.all(
            [...this.managedDatabases].map(([relativePath, opening]) =>
                opening.then((db) => db.close()).catch(logFailure(relativePath)),
            ),
        );
        this.managedDatabases.clear();
        this.onClosed?.();
    }

    // Every use restarts the idle timer.
    public touch(): this {
        this.startIdleTimer(this.idleMs);
        return this;
    }

    // Keeps the home open, however long the work takes, until the returned release is called. A holder that
    // must stop when the home closes anyway, such as for a restore, passes onClosing. The home runs it when the
    // close starts, before the parts close, unlike the onClosed of the constructor, which runs when the close
    // is done. A holder that opened the home only for itself may ask for a shorter idle when it lets go. A
    // closing home refuses, because its holder would never hear the close.
    public hold(onClosing?: () => void): (idleMs?: number) => void {
        this.refuseIfClosing();
        this.holds++;
        clearTimeout(this.idleTimer);
        // A callback of its own, so two holds that pass the same function stay two entries.
        const callback = onClosing && (() => onClosing());
        if (callback) this.holderCloseCallbacks.add(callback);
        // Releasing twice must not count as two releases.
        let released = false;
        return (idleMs = this.idleMs) => {
            if (released) return;
            released = true;
            this.holds--;
            if (callback) this.holderCloseCallbacks.delete(callback);
            this.startIdleTimer(idleMs);
        };
    }

    // A long request, such as an upload, an export or an import, can outlast the idle timeout, so it holds
    // its Home until it ends.
    public async withHomeHeld<T>(fn: () => Promise<T>): Promise<T> {
        const release = this.hold();
        try {
            return await fn();
        } finally {
            release();
        }
    }

    private startIdleTimer(idleMs: number): void {
        if (this._closing || this.holds > 0) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            console.log(`[Home] Idle timeout for ${this.user.id}, closing`);
            this.close().catch((e) => console.error(`[Home] Close failed for ${this.user.id}:`, e));
        }, idleMs);
    }

    // One shared connection per database file under the home, closed when the home goes idle.
    // A closing home refuses, because the close might miss a database opened now, and the next
    // home would open the same file a second time.
    public async getLocalDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> {
        this.refuseIfClosing();
        let opening = this.managedDatabases.get(relativePath);
        if (!opening) {
            const opened = openLocalDatabase(config, path.join(this.homeDir, relativePath));
            // A failed open leaves no entry, so the next call tries again and the close skips it.
            opened.catch(() => {
                if (this.managedDatabases.get(relativePath) === opened) this.managedDatabases.delete(relativePath);
            });
            this.managedDatabases.set(relativePath, opened);
            opening = opened;
        }
        return opening as Promise<ManagedDatabase<S>>;
    }

    // The one answer to work that comes too late, such as a hold or a new mount: the client retries
    // and reaches the next home.
    public refuseIfClosing(): void {
        if (this._closing) throw new ApiError(503, 'Home is closing');
    }

    public subscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.add(listener);
        // Somebody has the home open in a tab, so changes made in other mail apps should reach them live.
        this._mail?.watchFolders().catch((err) => console.error(`[Home] Mail watch failed for ${this.user.id}:`, err));
    }

    public unsubscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.delete(listener);
    }

    public broadcast(event: SSEvent): void {
        for (const listener of this.sseListeners) {
            listener(event);
        }
    }

    // A team home has no notification center, so a notice to it is dropped.
    public notify(input: NotificationPersistInput): void {
        this.touch();
        this._notifications?.persist(input);
    }

    // Uses the fields, not the getters: a getter may refuse a part that is switched off, but its
    // files still take up space.
    public async dataSize(): Promise<number> {
        const [mail, contacts, calendar] = await Promise.all([
            this._mail?.size(),
            this._contacts?.size(),
            this._calendar?.size(),
        ]);
        return (mail ?? 0) + (contacts ?? 0) + (calendar ?? 0);
    }

    public async size(teamIds: string[] = []): Promise<HomeSizeResponse> {
        // A home without a drive has nothing to size.
        if (!this._drive) return homeSize();
        return userHomeSize(this.homeDir, this.settings.get(), await this.dataSize(), teamIds);
    }
}

// Sizes the default drive from its files and the saved settings, not from the live mount. So it
// answers the same for an open home, a closed one, and one whose default mount is switched off.
export async function userHomeSize(
    homeDir: string,
    settings: HomeSettings,
    dataUsed: number,
    teamIds: string[],
): Promise<HomeSizeResponse> {
    const driveUsed = readMountTotalSize(
        path.join(homeDir, PATHS.DRIVE.ROOT, DEFAULT_MOUNT_ID, PATHS.DRIVE.METADATA_DB),
    );
    const mountSettings = settings.mounts?.[DEFAULT_MOUNT_ID];
    const quotas = await resolveUserQuotas(
        mountSettings ? createMountConfig(DEFAULT_MOUNT_ID, mountSettings) : createDefaultMountConfig(),
        teamIds,
    );
    return homeSize(dataUsed, driveUsed, quotas);
}

export function homeSize(
    dataUsed = 0,
    driveUsed = 0,
    quotas: ResolvedQuotas = { homeDataMax: 0, mountMax: 0 },
): HomeSizeResponse {
    return {
        homeData: { used: dataUsed, max: quotas.homeDataMax },
        drive: { default: { used: driveUsed, max: quotas.mountMax } },
        total: { used: dataUsed + driveUsed, max: quotas.homeDataMax + quotas.mountMax },
    };
}
