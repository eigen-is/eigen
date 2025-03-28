// Home class for a user. Will be used to handle all the user's file operations, and cache the user's files.

import type {User} from "better-auth/types";
import type Database from "bun:sqlite";
import {fsGetDatabase} from "../fs/fs.ts";

const city = new Map<string, Home>();

class asyncCache<T> {
    private value: T | undefined;
    private createPromise: () => Promise<T>;
    private initializationStarted: boolean = false;

    constructor(create: () => Promise<T>) {
        this.createPromise = create;
    }

    public async get() {
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

    private initialized: boolean = false;
    private initializationStarted: boolean = false;
    private timeout: Timer | undefined;

    private databases: Map<string, asyncCache<Database>> = new Map();

    constructor(user: User) {
        this.user = user;
    }

    public async init() {
        if (this.touch() && this.initialized) {
            return true;
        }
        if (this.initializationStarted) {
            // Wait for initialization to complete
            return new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (this.initialized) {
                        clearInterval(interval);
                        resolve(true);
                    }
                }, 1);
            });
        }
        this.initializationStarted = true;
        this.initialized = true;
    }

    public touch() {
        // Reset the timeout
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            // remove the home from the cache
            city.delete(this.user.id);
            console.log(`Closed home for ${this.user.id}`);
        }, 1000 * 30);
        return true;
    }

    public async openSQLiteDatabase(file: string, onCreate: (db: Database) => Promise<void>) {
        if (this.databases.has(file)) {
            return await (this.databases.get(file)!.get()) as Database;
            ;
        }
        this.databases.set(file, new asyncCache(async () => {
            const db = await fsGetDatabase(this.user, file, true, onCreate);
            db.exec("PRAGMA journal_mode = WAL;");
            return db;
        }));
        return await (this.databases.get(file)!.get()) as Database;
    }
}

export async function getHome(user: User) {
    // Check if the user already has a home
    if (city.has(user.id)) {
        const home = city.get(user.id)!;
        await home.init();
        return home;
    } else {
        const home = new Home(user);
        city.set(user.id, home);
        await home.init();
        return home;
    }
}