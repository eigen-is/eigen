import type Database from "bun:sqlite";
import type {Storage} from "./storage.ts";

export default class EigenDatabase {
    public db!: Database;

    private storage: Storage;
    private pathId: string;

    constructor(storage: Storage, pathId: string) {
        this.storage = storage;
        this.pathId = pathId;
    }

    public async init() {
    }

    public async close() {
        this.db.close();
    }
}