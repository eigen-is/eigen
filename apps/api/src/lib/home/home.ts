import type {User} from 'better-auth/types';
import * as path from 'path';

import {
    type DatabaseConfig,
    type JsonStore,
    LocalFilesystem,
    ManagedDatabase,
    openLocalDatabase,
    type SchemaType
} from '../core';
import type {Contacts} from '../contacts/contacts';
import type Maildir from '../mail/maildir';
import type {Calendar} from '../calendar/calendar';
import type {SSEvent} from '@workspace/lib/types/sse';
import {createAsyncSingleton} from '../../utils/singleton';
import type {Drive} from '../drive';
import {resolveUserQuotas} from '../config/quota';

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

    protected initialized: boolean = false;
    protected initializationStarted: boolean = false;
    protected initWaiters: ((home: Home) => void)[] = [];
    protected timeout: Timer | undefined;

    private managedDatabases: Map<string, () => Promise<ManagedDatabase<any>>> = new Map();
    private sseListeners: ((event: SSEvent) => void)[] = [];
    private cleanUp: (() => void) | null = null;

    constructor(user: User, cleanUp?: () => void) {
        this.user = user;
        this.cleanUp = cleanUp || null;
    }

    get drive(): Drive { return this._drive; }
    get contacts(): Contacts { return this._contacts; }
    get mail(): Maildir { return this._mail; }
    get calendar(): Calendar { return this._calendar; }

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

        this.initialized = true;
        for (const resolve of this.initWaiters) {
            resolve(this);
        }
        this.initWaiters = [];
        return this;
    }

    public touch() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            this.destruct().finally(() => this.cleanUp?.());
        }, 1000 * 60 * 5);
        return this;
    }

    public async getLocalDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string
    ): Promise<ManagedDatabase<S>> {
        const absolutePath = path.join(this.homeDir, relativePath);
        return this.getManagedDatabase(relativePath, () => openLocalDatabase(config, absolutePath));
    }

    public subscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners.push(listener);
    }

    public unsubscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners = this.sseListeners.filter(l => l !== listener);
    }

    public async size(teamIds: string[] = []) {
        const [mail, contacts, driveDefault] = await Promise.all([
            this._mail?.size(),
            this._contacts?.size(),
            this._drive.size('default')
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

    public async getZip(): Promise<{ data: ArrayBuffer, contentType: string, fileName: string }> {
        throw new Error('Not implemented');
    }

    public notify(event: SSEvent) {
        for (const listener of this.sseListeners) {
            listener(event);
        }
    }

    private async getManagedDatabase<S extends SchemaType>(
        key: string,
        factory: () => Promise<ManagedDatabase<S>>
    ): Promise<ManagedDatabase<S>> {
        if (!this.managedDatabases.has(key)) {
            this.managedDatabases.set(key, createAsyncSingleton(factory));
        }
        return this.managedDatabases.get(key)!() as Promise<ManagedDatabase<S>>;
    }
}
