import type {User} from 'better-auth/types';
import * as path from 'path';

import {type DatabaseConfig, ManagedDatabase, openLocalDatabase, type SchemaType} from '../core/managed-database';
import {Contacts} from '../contacts/contacts';
import Maildir from '../mail/maildir';
import type {SSEvent} from '@workspace/lib/types/sse';
import {createAsyncSingleton} from '../../utils/singleton';
import {cleanupHomeFactory} from './get-home';
import {getUserHomePath} from '../config/paths';
import {LocalStorage} from '../storage';
import {Drive} from '../drive';

export class Home {
    public user: User;
    public homeDir: string;
    public fs: LocalStorage;

    public drive!: Drive;
    public contacts: Contacts;
    public mail: Maildir;

    private initialized: boolean = false;
    private initializationStarted: boolean = false;
    private initWaiters: ((home: Home) => void)[] = [];
    private timeout: Timer | undefined;
    private managedDatabases: Map<string, () => Promise<ManagedDatabase<any>>> = new Map();
    private sseListeners: ((event: SSEvent) => void)[] = [];

    constructor(user: User) {
        this.user = user;
        this.homeDir = getUserHomePath(user.id);
        this.fs = new LocalStorage(this.homeDir);
        this.contacts = new Contacts(this);
        this.mail = new Maildir(this);
    }

    public async init() {
        if (this.initialized) {
            return this;
        }
        if (this.initializationStarted) {
            return new Promise<Home>((resolve) => {
                this.initWaiters.push(resolve);
            });
        }
        this.initializationStarted = true;

        this.drive = new Drive(this);
        await this.drive.init();

        await this.contacts.init();
        await this.mail.init();

        this.initialized = true;
        for (const resolve of this.initWaiters) {
            resolve(this);
        }
        this.initWaiters = [];
        return this;
    }

    public async getManagedDatabase<S extends SchemaType>(
        key: string,
        factory: () => Promise<ManagedDatabase<S>>
    ): Promise<ManagedDatabase<S>> {
        if (!this.managedDatabases.has(key)) {
            this.managedDatabases.set(key, createAsyncSingleton(factory));
        }
        return this.managedDatabases.get(key)!() as Promise<ManagedDatabase<S>>;
    }

    public async getLocalDatabase<S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string
    ): Promise<ManagedDatabase<S>> {
        const absolutePath = path.join(this.homeDir, relativePath);
        return this.getManagedDatabase(relativePath, () => openLocalDatabase(config, absolutePath));
    }

    public async closeManagedDatabase(key: string): Promise<void> {
        const getter = this.managedDatabases.get(key);
        if (getter) {
            const db = await getter();
            await db.close();
            this.managedDatabases.delete(key);
        }
    }

    public subscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners.push(listener);
    }

    public unsubscribeSSE(listener: (event: SSEvent) => void) {
        this.sseListeners = this.sseListeners.filter(l => l !== listener);
    }

    public touch() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            cleanupHomeFactory(this.user.id);
            this.destruct();
        }, 1000 * 60 * 5);
        return this;
    }

    public async size() {
        const [mail, contacts, drive] = await Promise.all([
            this.mail.size(),
            this.contacts.size(),
            this.drive.size('default')
        ]);
        const maxMB = 50;
        const max = maxMB * 1024 * 1024;
        return {mail, contacts, drive, used: (mail + contacts + drive), max};
    }

    public async getZip(): Promise<{ data: ArrayBuffer, contentType: string, fileName: string }> {
        throw new Error('Not implemented');
    }

    public notify(event: SSEvent) {
        for (const listener of this.sseListeners) {
            listener(event);
        }
    }

    private async destruct() {
        try {
            await this.drive.destruct();
        } catch (error) {
            console.error('Failed to destruct drive:', error);
        }

        try {
            await this.contacts.destruct();
        } catch (error) {
            console.error('Failed to destruct contacts:', error);
        }

        try {
            await this.mail.destruct();
        } catch (error) {
            console.error('Failed to destruct mail:', error);
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
}
