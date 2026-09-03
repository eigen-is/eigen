import * as path from 'node:path';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import type { SSEvent } from '@workspace/lib/types/sse';
import { createAsyncSingleton } from '../../utils/singleton';
import { time } from '../../utils/timing';
import type { Calendar } from '../calendar/calendar';
import { resolveUserQuotas } from '../config/quota';
import type { Contacts } from '../contacts/contacts';
import {
    type DatabaseConfig,
    type JsonStore,
    type LocalFilesystem,
    type ManagedDatabase,
    openLocalDatabase,
    type SchemaType,
} from '../core';
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

    protected _drive?: Drive;
    protected _contacts!: Contacts;
    protected _mail!: Mail;
    protected _calendar!: Calendar;
    protected _notifications!: NotificationCenter;

    protected idleMs = 1000 * 60 * 5;

    private initialized: boolean = false;
    private initializationStarted: boolean = false;
    private initWaiters: { resolve: (home: Home) => void; reject: (reason: unknown) => void }[] = [];
    private timeout: Timer | undefined;
    private _destructing: boolean = false;
    private _destructPromise: Promise<void> | null = null;

    get destructing(): boolean {
        return this._destructing;
    }

    private managedDatabases: Map<string, () => Promise<ManagedDatabase<SchemaType>>> = new Map();
    private sseListeners: ((event: SSEvent) => void)[] = [];
    private cleanUp: (() => void) | null = null;

    constructor(user: User, cleanUp?: () => void) {
        this.user = user;
        this.cleanUp = cleanUp || null;
    }

    get drive(): Drive {
        this.touch();
        return this._drive!;
    }

    get contacts(): Contacts {
        this.touch();
        return this._contacts;
    }

    get mail(): Mail {
        this.touch();
        return this._mail;
    }

    get calendar(): Calendar {
        this.touch();
        return this._calendar;
    }

    get notifications(): NotificationCenter {
        this.touch();
        return this._notifications;
    }

    get hasCalendar(): boolean {
        return !!this._calendar;
    }

    public async init(autoCreateDefaultMount: boolean = false) {
        if (this.initialized) {
            return this;
        }
        if (this.initializationStarted) {
            return new Promise<Home>((resolve, reject) => {
                this.initWaiters.push({ resolve, reject });
            });
        }
        this.initializationStarted = true;

        try {
            await time('Home.init.settings', () => this.settings?.load() ?? Promise.resolve());

            // allSettled (not all): if one subsystem init throws, let its peers finish opening before
            // we tear down — a rejected Promise.all returns while siblings are still mid-init, so
            // their ManagedDatabases + upload/reindex timers would leak.
            const results = await Promise.allSettled([
                time('Home.init.drive', () => this._drive?.init(autoCreateDefaultMount) ?? Promise.resolve()),
                time('Home.init.contacts', () => this._contacts?.init() ?? Promise.resolve()),
                time('Home.init.mail', () => this._mail?.init() ?? Promise.resolve()),
                time('Home.init.calendar', () => this._calendar?.init() ?? Promise.resolve()),
                time('Home.init.notifications', () => this._notifications?.init() ?? Promise.resolve()),
            ]);
            const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failed) throw failed.reason;

            this.initialized = true;
            console.log(`[Home] Initialized for ${this.user.id}`);
            for (const { resolve } of this.initWaiters) {
                resolve(this);
            }
            this.initWaiters = [];
            return this;
        } catch (err) {
            // One failure path for the whole init body (settings load included): the idempotent
            // shutdown() (see destruct) closes what got built and clears the idle timer, queued
            // concurrent init() callers are rejected — they'd otherwise await forever — and the
            // rethrow makes getHome discard this half-built Home instead of caching a leaking one.
            await this.shutdown();
            for (const { reject } of this.initWaiters) {
                reject(err);
            }
            this.initWaiters = [];
            throw err;
        }
    }

    public touch() {
        if (this._destructing) return this;
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            console.log(`[Home] Idle timeout for ${this.user.id}, destructing`);
            this.destruct()
                .catch((e) => console.error(`[Home] Destruct failed for ${this.user.id}:`, e))
                .finally(() => this.cleanUp?.());
        }, this.idleMs);
        return this;
    }

    public async shutdown() {
        if (this.timeout) clearTimeout(this.timeout);
        await this.destruct();
    }

    public async getLocalDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> {
        const absolutePath = path.join(this.homeDir, relativePath);
        return this.getManagedDatabase(relativePath, () => openLocalDatabase(config, absolutePath));
    }

    public subscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners.push(listener);
    }

    public unsubscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners = this.sseListeners.filter((l) => l !== listener);
    }

    public createSSEStream(getHome: (userId: string) => Promise<Home>): ReadableStream<SSEvent | { event: string }> {
        let keepalive: Timer | null = null;
        let listener: ((event: SSEvent) => void) | null = null;
        let isClosed = false;
        let currentHome: Home = this;

        return new ReadableStream({
            start: (controller) => {
                listener = (event: SSEvent) => {
                    if (isClosed || controller.desiredSize === null) return;
                    try {
                        controller.enqueue(event);
                    } catch {
                        isClosed = true;
                    }
                };

                currentHome.subscribeSSE(listener);

                try {
                    controller.enqueue({ event: 'keepalive' });
                } catch {
                    isClosed = true;
                }

                keepalive = setInterval(async () => {
                    if (isClosed) return;

                    // Re-acquire Home if it was recreated externally
                    try {
                        const freshHome = await getHome(this.user.id); // own home: re-acquire after recreation
                        if (freshHome !== currentHome) {
                            console.log(`[SSE] Home recreated for ${this.user.id}, re-subscribing`);
                            try {
                                currentHome.unsubscribeSSE(listener!);
                            } catch {}
                            freshHome.subscribeSSE(listener!);
                            currentHome = freshHome;
                        }
                    } catch (e) {
                        console.error(`[SSE] Failed to get Home for ${this.user.id}:`, e);
                    }

                    if (controller.desiredSize === null) {
                        isClosed = true;
                        return;
                    }
                    try {
                        controller.enqueue({ event: 'keepalive' });
                    } catch {
                        isClosed = true;
                    }
                }, 15000);
            },
            cancel: () => {
                isClosed = true;
                if (keepalive) clearInterval(keepalive);
                if (listener) {
                    try {
                        currentHome.unsubscribeSSE(listener);
                    } catch {}
                }
            },
        });
    }

    public async size(teamIds: string[] = []): Promise<HomeSizeResponse> {
        // Org homes have no drive — nothing to size, return early before touching subsystems.
        if (!this._drive) {
            return {
                mailAndContacts: { used: 0, max: 0 },
                drive: { default: { used: 0, max: 0 } },
                total: { used: 0, max: 0 },
            };
        }

        const [mail, contacts, driveDefault] = await Promise.all([
            this._mail?.size(),
            this._contacts?.size(),
            this._drive.size('default'),
        ]);

        const mountConfig = this._drive.getMountConfig('default');
        const quotas = await resolveUserQuotas(mountConfig, teamIds);
        const mailAndContactsUsed = (mail || 0) + (contacts || 0);

        return {
            mailAndContacts: { used: mailAndContactsUsed, max: quotas.mailAndContactsMax },
            drive: { default: { used: driveDefault, max: quotas.mountMax } },
            total: {
                used: mailAndContactsUsed + driveDefault,
                max: quotas.mailAndContactsMax + quotas.mountMax,
            },
        };
    }

    protected destruct(): Promise<void> {
        // Idempotent: the idle timer and an explicit shutdown() (e.g. getHome evicting a home that is
        // already tearing down) can both fire, so run teardown once — a second concurrent pass would
        // close, checkpoint and journal-unlink the same DB files twice.
        if (this._destructPromise) return this._destructPromise;
        this._destructing = true;
        this._destructPromise = (async () => {
            // Subsystems close their own ManagedDatabase. Run those first so the
            // managedDatabases loop below is a safety net (idempotent close), not a
            // concurrent second close on the same db.
            const subsystems: [string, Promise<unknown> | undefined][] = [
                ['drive', this._drive?.destruct()],
                ['contacts', this._contacts?.destruct()],
                ['mail', this._mail?.destruct()],
                ['calendar', this._calendar?.destruct()],
                ['notifications', this._notifications?.destruct()],
            ];
            for (const [i, result] of (await Promise.allSettled(subsystems.map(([, p]) => p))).entries()) {
                if (result.status === 'rejected') {
                    console.error(`Failed to destruct ${subsystems[i][0]}:`, result.reason);
                }
            }

            const dbs = [...this.managedDatabases.entries()].map(([key, getter]): [string, Promise<unknown>] => [
                key,
                (async () => (await getter()).close())(),
            ]);
            for (const [i, result] of (await Promise.allSettled(dbs.map(([, p]) => p))).entries()) {
                if (result.status === 'rejected') {
                    console.error(`Failed to close managed database ${dbs[i][0]}:`, result.reason);
                }
            }

            this.managedDatabases.clear();
        })();
        return this._destructPromise;
    }

    public broadcast(event: SSEvent) {
        for (const listener of this.sseListeners) {
            listener(event);
        }
    }

    private async getManagedDatabase<S extends SchemaType>(
        key: string,
        factory: () => Promise<ManagedDatabase<S>>,
    ): Promise<ManagedDatabase<S>> {
        if (!this.managedDatabases.has(key)) {
            this.managedDatabases.set(key, createAsyncSingleton(factory));
        }
        return this.managedDatabases.get(key)!() as Promise<ManagedDatabase<S>>;
    }
}
