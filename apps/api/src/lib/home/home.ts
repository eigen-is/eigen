// A Home is everything one owner keeps on this server: a user's drive, mail, contacts, calendar and
// notifications, or the smaller set a team, an org or a guest has. Every request, SSE stream, collab
// socket and DAV call reaches its data through getHome(ownerId), which builds the Home on first use.
// It stays loaded while it is used and closes itself, databases included, after a few idle minutes.
// This base class owns that lifecycle; the user, team, org and guest homes decide which parts exist.

import * as path from 'node:path';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { createAsyncSingleton } from '../../utils/singleton';
import { time } from '../../utils/timing';
import type { Calendar } from '../calendar/calendar';
import type { ResolvedQuotas } from '../config/quota';
import { resolveUserQuotas } from '../config/quota';
import type { Contacts } from '../contacts/contacts';
import type { DatabaseConfig, JsonStore, LocalFilesystem, ManagedDatabase, SchemaType } from '../core';
import { openLocalDatabase } from '../core';
import type { Drive } from '../drive';
import type { Mail } from '../mail/mail-domain';
import type { NotificationCenter } from '../notification-center/notification-center';
import type { User } from '../user';

export type HomeSettings = Pick<UserSettings, 'mounts'>;

export class Home {
    public user: User;
    public homeDir!: string;
    public fs!: LocalFilesystem;
    public settings!: JsonStore<HomeSettings>;

    // Which parts exist depends on the kind of home: an org home has none, a team home only drive and calendar.
    protected _drive?: Drive;
    protected _contacts?: Contacts;
    protected _mail?: Mail;
    protected _calendar?: Calendar;
    protected _notifications?: NotificationCenter;

    // The last time a request or a keepalive reached this home. A backup does not update it,
    // so after a backup we can tell whether someone else opened the home in the meantime.
    public requestedAt = 0;
    protected idleMs = 1000 * 60 * 5;

    private idleTimer: Timer | undefined;
    private initPromise: Promise<this> | null = null;
    private destructPromise: Promise<void> | null = null;
    private _destructing = false;
    private readonly cleanUp: (() => void) | undefined;
    private readonly managedDatabases = new Map<string, () => Promise<ManagedDatabase<SchemaType>>>();
    private readonly sseListeners = new Set<(event: SSEvent) => void>();

    public constructor(user: User, cleanUp?: () => void) {
        this.user = user;
        this.cleanUp = cleanUp;
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

    public get destructing(): boolean {
        return this._destructing;
    }

    public init(autoCreateDefaultMount = false): Promise<this> {
        return (this.initPromise ??= this.runInit(autoCreateDefaultMount));
    }

    private async runInit(autoCreateDefaultMount: boolean): Promise<this> {
        try {
            // An org home has no settings.
            await time('Home.init.settings', async () => this.settings?.load());

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
            await this.shutdown();
            throw err;
        }
    }

    // Every use restarts the idle timer. A backup passes a short idleMs, so a home it woke up
    // only for the backup closes again soon.
    public touch(idleMs = this.idleMs): this {
        if (this._destructing) return this;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            console.log(`[Home] Idle timeout for ${this.user.id}, destructing`);
            this.destruct()
                .catch((e) => console.error(`[Home] Destruct failed for ${this.user.id}:`, e))
                .finally(() => this.cleanUp?.());
        }, idleMs);
        return this;
    }

    public async shutdown(): Promise<void> {
        clearTimeout(this.idleTimer);
        await this.destruct();
    }

    // Runs once, even when the idle timer and shutdown() both call it: closing the same database files twice is unsafe.
    protected destruct(): Promise<void> {
        this._destructing = true;
        return (this.destructPromise ??= this.runDestruct());
    }

    private async runDestruct(): Promise<void> {
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

    // Uses the fields, not the getters: a team's calendar getter throws when the calendar is off,
    // but its files still take up space.
    public async dataSize(): Promise<number> {
        const [mail, contacts, calendar] = await Promise.all([
            this._mail?.size(),
            this._contacts?.size(),
            this._calendar?.size(),
        ]);
        return (mail ?? 0) + (contacts ?? 0) + (calendar ?? 0);
    }

    public async size(teamIds: string[] = []): Promise<HomeSizeResponse> {
        // Org homes have no drive: nothing to size.
        if (!this._drive) return homeSize();

        const [dataUsed, driveUsed] = await Promise.all([this.dataSize(), this._drive.size('default')]);
        const quotas = await resolveUserQuotas(this._drive.getMountConfig('default'), teamIds);

        return homeSize(dataUsed, driveUsed, quotas);
    }
}

// Without arguments it returns all zeros, for a home that has nothing to count.
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
