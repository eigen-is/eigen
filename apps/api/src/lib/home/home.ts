import type {User} from 'better-auth/types';
import * as path from 'path';

import {type DatabaseConfig, ManagedDatabase, openLocalDatabase, type SchemaType} from '../core';
import {Contacts} from '../contacts/contacts';
import Maildir from '../mail/maildir';
import type {Calendar} from '../calendar/calendar';
import type {SSEvent} from '@workspace/lib/types/sse';
import {createAsyncSingleton} from '../../utils/singleton';
import {Drive} from '../drive';
import {LocalFilesystem} from "../core";

export class Home {
    public user: User;
    public homeDir!: string;
    public fs!: LocalFilesystem;

    public drive!: Drive;
    public contacts!: Contacts;
    public mail!: Maildir;
    public calendar!: Calendar;

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

        await this.drive?.init();
        await this.contacts?.init();
        await this.mail?.init();
        await this.calendar?.init();

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
            this.cleanUp && this.cleanUp();
            return this.destruct();
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

    public async size() {
        const [mail, contacts, drive] = await Promise.all([
            this.mail?.size(),
            this.contacts?.size(),
            this.drive.size('default')
        ]);
        const maxMB = 50;
        const max = maxMB * 1024 * 1024;
        return {mail, contacts, drive, used: ((mail || 0) + (contacts || 0) + drive), max};
    }

    protected async destruct() {
        try {
            await this.drive.destruct();
        } catch (error) {
            console.error('Failed to destruct drive:', error);
        }

        try {
            await this.contacts?.destruct();
        } catch (error) {
            console.error('Failed to destruct contacts:', error);
        }

        try {
            await this.mail?.destruct();
        } catch (error) {
            console.error('Failed to destruct mail:', error);
        }

        try {
            await this.calendar?.destruct();
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
