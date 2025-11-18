import type {User} from "better-auth/types";
import type Database from "bun:sqlite";
import {Contacts} from "../contacts/contacts.ts";
import Maildir from "../mail/maildir.ts";
import FileSystem from "./filesystem.ts";
import {getUserById} from "../users/users.ts";
import Drive from "../drive/drive.ts";
import type {ServerWebSocket} from "bun";
import type {EigenNotification} from "../../types/notification.ts";
import { createAsyncSingleton } from '../../utils/singleton';

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export class asyncCache<T> {
    private value: T | undefined;
    private createPromise: () => Promise<T>;
    private initializationStarted: boolean = false;

    constructor(create: () => Promise<T>) {
        this.createPromise = create;
    }

    public async get(): Promise<T> {
        if (this.value) {
            return this.value;
        }
        if (this.initializationStarted) {
            // Wait for initialization to complete
            return new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (this.value) {
                        console.log('Resolved, asyncCache is ready');
                        clearInterval(interval);
                        resolve(this.value);
                    }
                }, 1);
            });
        }
        this.initializationStarted = true;
        return this.value = await this.createPromise();
    }
}

export class Home {
    public user: User;

    public fs: FileSystem;
    public drive: Drive;
    public contacts: Contacts;
    public mail: Maildir;

    private initialized: boolean = false;
    private initializationStarted: boolean = false;
    private timeout: Timer | undefined;

    private databases: Map<string, () => Promise<Database>> = new Map();
    private notificationSockets: ServerWebSocket[] = [];

    constructor(user: User) {
        this.user = user;
        this.fs = new FileSystem(this);
        this.drive = new Drive(this);
        this.contacts = new Contacts(this);
        this.mail = new Maildir(this, this.notify.bind(this));
    }

    public async init() {
        if (this.initialized) {
            return this;
        }
        if (this.initializationStarted) {
            // Wait for initialization to complete
            return new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (this.initialized) {
                        clearInterval(interval);
                        resolve(this);
                    }
                }, 1);
            });
        }
        this.initializationStarted = true;

        await this.fs.init();
        await this.drive.init();
        await this.contacts.init();
        await this.mail.init();

        this.initialized = true;
        return this;
    }

    public subscribe(ws: ServerWebSocket) {
        this.notificationSockets.push(ws);
    }

    public unsubscribe(ws: ServerWebSocket) {
        this.notificationSockets = this.notificationSockets.filter(socket => socket !== ws);
    }

    public touch() {
        // Reset the timeout
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            // remove the home from the cache
            homeFactories.delete(this.user.id);
            this.destruct();
            console.log(`Closed home for ${this.user.id}`);
        }, 1000 * 60 * 5); // 5 minutes
        return this;
    }

    public async openSQLiteDatabase(file: string, onCreate: (db: Database) => Promise<void>) {
        console.log(file, this.databases.has(file));
        
        if (!this.databases.has(file)) {
            this.databases.set(file, createAsyncSingleton(async () => {
                const db = await this.fs.createAndOpenDatabase(file, true, onCreate);
                db.exec("PRAGMA journal_mode = WAL;");
                return db;
            }));
        }
        return await this.databases.get(file)!() as Database;
    }

    public async closeSQLiteDatabase(db: Database) {
        for (const key of this.databases.keys()) {
            const database = await this.databases.get(key)!() as Database;
            if (database === db) {
                database.close();
                this.databases.delete(key);
            }
        }
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

    public notify(event: EigenNotification) {
        this.notificationSockets = this.notificationSockets.filter(ws => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify(event));
                return true;
            }
        });
    }

    public async getZip() {
        return await this.fs.getZip();
    }

    private async destruct() {
        this.contacts = undefined!;
    }
}

export function getHome(user: User): Promise<Home> {
    // Create a factory for this user if it doesn't exist
    if (!homeFactories.has(user.id)) {
      homeFactories.set(user.id, createAsyncSingleton(async () => {
        // Check if user exists
        const userExists = await getUserById(user.id);
        if (!userExists) {
          throw new Error('User not found');
        }
        
        // Create and initialize the home
        const home = new Home(user);
        await home.init();
        return home.touch();
      }));
    }
    
    // Always return from the factory, which handles initialization once
    return homeFactories.get(user.id)!();
  }