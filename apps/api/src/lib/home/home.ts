import type {User} from 'better-auth/types';
import type Database from 'bun:sqlite';
import {Database as BunDatabase} from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'node:fs';

import {type DatabaseConfig, ManagedDatabase, openLocalDatabase, type SchemaType} from '../core/managed-database';
import {Contacts} from '../contacts/contacts';
import Maildir from '../mail/maildir';
import {getUserById} from '../users/users';
import type {SSEvent} from '@workspace/lib/types/sse';
import {createAsyncSingleton} from '../../utils/singleton';
import {getUserHomePath} from '../config/paths';
import {LocalStorage} from '../storage';
import Drive from '../drive/drive';

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export class Home {
    public user: User;
    public homeDir: string;
    public fs: LocalStorage;

    public drive!: Drive;
    public contacts: Contacts;
    public mail: Maildir;

    private initialized: boolean = false;
    private initializationStarted: boolean = false;
    private timeout: Timer | undefined;

    private databases: Map<string, Database> = new Map();
    private databaseFactories: Map<string, () => Promise<Database>> = new Map();
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
                const interval = setInterval(() => {
                    if (this.initialized) {
                        clearInterval(interval);
                        resolve(this);
                    }
                }, 1);
            });
        }
        this.initializationStarted = true;

        this.drive = new Drive(this);
        await this.drive.init();

        await this.contacts.init();
        await this.mail.init();

        this.initialized = true;
        return this;
    }

    public async getDatabase(
        relativePath: string,
        onCreate: (db: Database) => Promise<void>
    ): Promise<Database> {
        if (this.databases.has(relativePath)) {
            return this.databases.get(relativePath)!;
        }

        if (!this.databaseFactories.has(relativePath)) {
            this.databaseFactories.set(relativePath, createAsyncSingleton(async () => {
                const absolutePath = path.join(this.homeDir, relativePath);
                const dirPath = path.dirname(absolutePath);

                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, {recursive: true});
                }

                const fileExists = fs.existsSync(absolutePath);
                const db = new BunDatabase(absolutePath, {create: true});

                db.run('PRAGMA journal_mode = WAL;');
                db.run('PRAGMA foreign_keys = ON;');
                db.run('PRAGMA busy_timeout = 5000;');
                db.run('PRAGMA wal_checkpoint(TRUNCATE);');

                if (!fileExists) {
                    await onCreate(db);
                }

                this.databases.set(relativePath, db);
                return db;
            }));
        }

        return await this.databaseFactories.get(relativePath)!();
    }

    public async openSQLiteDatabase(
        relativePath: string,
        onCreate: (db: Database) => Promise<void>
    ): Promise<Database> {
        return this.getDatabase(relativePath, onCreate);
    }

    public async closeSQLiteDatabase(db: Database): Promise<void> {
        for (const [key, database] of this.databases.entries()) {
            if (database === db) {
                database.close();
                this.databases.delete(key);
                this.databaseFactories.delete(key);
                break;
            }
        }
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
            homeFactories.delete(this.user.id);
            this.destruct();
        }, 1000 * 60 * 5);
        return this;
    }

    public async size() {
        const [mail, contacts, drive] = await Promise.all([
            this.mail.size(),
            this.contacts.size(),
            this.drive.size()
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
        for (const db of this.databases.values()) {
            try {
                db.close();
            } catch (error) {
                console.error('Failed to close database:', error);
            }
        }
        this.databases.clear();
        this.databaseFactories.clear();

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

export function getHome(user: User): Promise<Home> {
    if (!homeFactories.has(user.id)) {
        homeFactories.set(user.id, createAsyncSingleton(async () => {
            const userExists = await getUserById(user.id);
            if (!userExists) {
                throw new Error('User not found');
            }

            const home = new Home(user);
            await home.init();
            return home.touch();
        }));
    }

    return homeFactories.get(user.id)!();
}
