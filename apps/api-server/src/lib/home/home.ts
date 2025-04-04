import type {User} from "better-auth/types";
import type Database from "bun:sqlite";
import {Contacts} from "../contacts/contacts.ts";
import Maildir from "../mail/maildir.ts";
import FileSystem from "./filesystem.ts";
import {getUserById} from "../users/users.ts";
import Drive from "../drive/drive.ts";

const city = new Map<string, Home>();

class asyncCache<T> {
    private value: T | undefined;
    private createPromise: () => Promise<T>;
    private initializationStarted: boolean = false;

    constructor(create: () => Promise<T>) {
        this.createPromise = create;
    }

    public async get(): Promise<T> {
        if (this.value) {
            console.log('Database from cache');
            return this.value;
        }
        if (this.initializationStarted) {
            // Wait for initialization to complete
            return new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (this.value) {
                        console.log('Resolved, database is ready');
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

    private databases: Map<string, asyncCache<Database>> = new Map();

    constructor(user: User) {
        this.user = user;
        this.fs = new FileSystem(this);
        this.drive = new Drive(this);
        this.contacts = new Contacts(this);
        this.mail = new Maildir(this);
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

    public touch() {
        // Reset the timeout
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            // remove the home from the cache
            city.delete(this.user.id);
            this.destruct();
            console.log(`Closed home for ${this.user.id}`);
        }, 1000 * 60 * 5); // 5 minutes
        return this;
    }

    public async openSQLiteDatabase(file: string, onCreate: (db: Database) => Promise<void>) {
        if (this.databases.has(file)) {
            return await (this.databases.get(file)!.get()) as Database;
        }
        this.databases.set(file, new asyncCache(async () => {
            const db = await this.fs.createAndOpenDatabase(file, true, onCreate);
            db.exec("PRAGMA journal_mode = WAL;");
            return db;
        }));
        return await (this.databases.get(file)!.get()) as Database;
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

    private async destruct() {
        this.contacts = undefined!;
    }
}

export async function getHome(user: User) {
    // Check if the user already has a home
    if (city.has(user.id)) {
        const home = city.get(user.id)!;
        await home.init();
        return home.touch();
    } else {
        const home = new Home(user);
        city.set(user.id, home);
        // check if user exists
        const userExists = await getUserById(user.id);
        if (!userExists) {
            city.delete(user.id);
            throw new Error('User not found');
        }
        await home.init();
        return home.touch();
    }
}