import * as path from 'node:path';
import type {SSEvent} from '@workspace/lib/types/sse';
import type {User} from 'better-auth/types';
import {createAsyncSingleton} from '../../utils/singleton';
import type {Calendar} from '../calendar/calendar';
import {resolveUserQuotas} from '../config/quota';
import type {Contacts} from '../contacts/contacts';
import {
    type DatabaseConfig,
    type JsonStore,
    type LocalFilesystem,
    type ManagedDatabase,
    openLocalDatabase,
    type SchemaType,
} from '../core';
import type {Drive} from '../drive';
import type Maildir from '../mail/maildir';
import type {NotificationCenter} from '../notification-center/notification-center';

export type HomeSettings = Record<string, unknown>;

export class Home {
    public user: User;
    public homeDir!: string;
    public fs!: LocalFilesystem;

    public settings!: JsonStore<HomeSettings>;

    protected _drive!: Drive;
    protected _contacts!: Contacts;
    protected _mail!: Maildir;
    protected _calendar!: Calendar;
    protected _notifications!: NotificationCenter;

    protected initialized: boolean = false;
    protected initializationStarted: boolean = false;
    protected initWaiters: ((home: Home) => void)[] = [];
    protected timeout: Timer | undefined;
    private _destructing: boolean = false;

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
        return this._drive;
    }

    get contacts(): Contacts {
        this.touch();
        return this._contacts;
    }

    get mail(): Maildir {
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

    public async init(autoCreateDefaultMount: boolean = false) {
        if (this.initialized) {
            return this;
        }
        if (this.initializationStarted) {
            return new Promise<Home>((resolve) => {
                this.initWaiters.push(resolve);
            });
        }
        this.initializationStarted = true;

        await this.settings?.load();
        await this._drive?.init(autoCreateDefaultMount);
        await this._contacts?.init();
        await this._mail?.init();
        await this._calendar?.init();
        await this._notifications?.init();

        this.initialized = true;
        console.log(`[Home] Initialized for ${this.user.id}`);
        for (const resolve of this.initWaiters) {
            resolve(this);
        }
        this.initWaiters = [];
        return this;
    }

    public touch() {
        if (this._destructing) return this;
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(
            () => {
                console.log(`[Home] Idle timeout for ${this.user.id}, destructing`);
                this.destruct().finally(() => this.cleanUp?.());
            },
            1000 * 60 * 5,
        );
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

    public async size(teamIds: string[] = []) {
        const [mail, contacts, driveDefault] = await Promise.all([
            this._mail?.size(),
            this._contacts?.size(),
            this._drive.size('default'),
        ]);

        const mountConfig = this._drive.getMountConfig('default');
        const quotas = await resolveUserQuotas(mountConfig, teamIds);
        const mailAndContactsUsed = (mail || 0) + (contacts || 0);

        return {
            mailAndContacts: {used: mailAndContactsUsed, max: quotas.mailAndContactsMax},
            drive: {default: {used: driveDefault, max: quotas.mountMax}},
            total: {
                used: mailAndContactsUsed + driveDefault,
                max: quotas.mailAndContactsMax + quotas.mountMax,
            },
        };
    }

    protected async destruct() {
        this._destructing = true;
        try {
            await this._drive.destruct();
        } catch (error) {
            console.error('Failed to destruct drive:', error);
        }

        try {
            await this._contacts?.destruct();
        } catch (error) {
            console.error('Failed to destruct contacts:', error);
        }

        try {
            await this._mail?.destruct();
        } catch (error) {
            console.error('Failed to destruct mail:', error);
        }

        try {
            await this._calendar?.destruct();
        } catch (error) {
            console.error('Failed to destruct calendar:', error);
        }

        try {
            await this._notifications?.destruct();
        } catch (error) {
            console.error('Failed to destruct notifications:', error);
        }

        for (const [key, getter] of this.managedDatabases) {
            try {
                const db = await getter();
                await db.close();
            } catch (error) {
                console.error(`Failed to close managed database ${key}:`, error);
            }
        }
        this.managedDatabases.clear();
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
