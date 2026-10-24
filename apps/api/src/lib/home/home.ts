// A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
// or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
// builds the Home on first use. It stays loaded while it is used and closes itself, databases
// included, after a few idle minutes. This base class owns that lifecycle; each kind of home
// decides which parts it has.

import * as path from 'node:path';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { createAsyncSingleton } from '../../utils/singleton';
import { time } from '../../utils/timing';
import type { Calendar } from '../calendar/calendar';
import type { ResolvedQuotas } from '../config/quota';
import { resolveUserQuotas } from '../config/quota';
import type { Contacts } from '../contacts/contacts';
import type { DatabaseConfig, JsonStore, ManagedDatabase, SchemaType } from '../core';
import { LocalFilesystem, openLocalDatabase } from '../core';
import type { Drive } from '../drive';
import type { Mail } from '../mail/mail-domain';
import type { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';

export type HomeSettings = Pick<UserSettings, 'mounts'>;

export class Home {
    public readonly user: User;
    public readonly homeDir: string;
    public readonly fs: LocalFilesystem;
    public settings!: JsonStore<HomeSettings>;

    // Which parts exist depends on the kind of home. A part the home doesn't have stays undefined.
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
    private readonly onClosed: (() => void) | undefined;
    private readonly managedDatabases = new Map<string, () => Promise<ManagedDatabase<SchemaType>>>();
    private readonly sseListeners = new Set<(event: SSEvent) => void>();

    public constructor(user: User, homeDir: string, onClosed?: () => void) {
        this.user = user;
        this.homeDir = homeDir;
        this.fs = new LocalFilesystem(homeDir);
        this.onClosed = onClosed;
    }

    public get drive(): Drive {
        this.touch();
        return this._drive!;
    }

    public get contacts(): Contacts {
        this.touch();
        return this._contacts!;
    }

    public get mail(): Mail {
        this.touch();
        return this._mail!;
    }

    public get calendar(): Calendar {
        this.touch();
        return this._calendar!;
    }

    public get notifications(): NotificationCenter {
        this.touch();
        return this._notifications!;
    }

    public get hasCalendar(): boolean {
        return !!this._calendar;
    }

    public get closing(): boolean {
        return this._closing;
    }

    public init(autoCreateDefaultMount = false): Promise<this> {
        return (this.initPromise ??= this.runInit(autoCreateDefaultMount));
    }

    private async runInit(autoCreateDefaultMount: boolean): Promise<this> {
        try {
            await time('Home.init.settings', () => this.settings.load());

            // allSettled waits for every part. Promise.all would return at the first failure while
            // the other parts are still opening databases and starting timers, and those would leak.
            const results = await Promise.allSettled([
                time('Home.init.drive', async () => this._drive?.init(autoCreateDefaultMount)),
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
            // Rethrow, so getHome drops this half-built Home instead of keeping it.
            await this.close();
            throw err;
        }
    }

    // Runs once, however often it is called: closing the same database files twice is unsafe.
    public close(): Promise<void> {
        if (!this.closePromise) {
            this._closing = true;
            clearTimeout(this.idleTimer);
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
            [...this.managedDatabases].map(([relativePath, open]) =>
                open()
                    .then((db) => db.close())
                    .catch(logFailure(relativePath)),
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

    // Keeps the home open, however long the work takes, until the returned release is called.
    // A holder that opened the home only for itself may ask for a shorter idle when it lets go.
    public hold(): (idleMs?: number) => void {
        this.holds++;
        clearTimeout(this.idleTimer);
        return (idleMs = this.idleMs) => {
            this.holds--;
            this.startIdleTimer(idleMs);
        };
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
    public async getLocalDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> {
        let open = this.managedDatabases.get(relativePath);
        if (!open) {
            open = createAsyncSingleton(() => openLocalDatabase(config, path.join(this.homeDir, relativePath)));
            this.managedDatabases.set(relativePath, open);
        }
        return open() as Promise<ManagedDatabase<S>>;
    }

    public subscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.add(listener);
    }

    public unsubscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.delete(listener);
    }

    public broadcast(event: SSEvent): void {
        for (const listener of this.sseListeners) {
            listener(event);
        }
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

        const [dataUsed, driveUsed] = await Promise.all([this.dataSize(), this._drive.size('default')]);
        const quotas = await resolveUserQuotas(this._drive.getMountConfig('default'), teamIds);

        return homeSize(dataUsed, driveUsed, quotas);
    }
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
