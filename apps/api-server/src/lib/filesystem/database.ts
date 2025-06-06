import Database, {constants} from "bun:sqlite";
import FileSystem from "./filesystem.ts";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export default class EigenDatabase<T extends Record<string, unknown>> {
    public db!: BunSQLiteDatabase<T>;

    protected _db!: Database;

    private fileSystem: FileSystem;
    private pathId: string;
    private uploadInterval: NodeJS.Timeout | undefined;
    private lastUploadTime: number = 0;

    constructor(fileSystem: FileSystem, pathId: string) {
        this.fileSystem = fileSystem;
        this.pathId = pathId;
    }

    public async init(schema: Record<string, unknown>, onCreate: (db: Database) => Promise<void>) {
        if (await this.fileSystem.existsOnStorage(this.pathId)) {
            const tempFilePath = await this.fileSystem.downloadToTemp(this.pathId);
            this._db = new Database(tempFilePath);
        } else {
            const tempFilePath = this.fileSystem.getTempFilePath(this.pathId);
            this._db = new Database(tempFilePath, {create: true});
            await onCreate(this._db);
        }
        this._db.exec("PRAGMA journal_mode = WAL;");
        this._db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
        this.db = drizzle(this._db, schema);

        this.lastUploadTime = Date.now();

        // set interval to check for changes and upload if needed
        this.uploadInterval = setInterval(async () => {
            if (await this.hasFileChanged()) {
                await this.fileSystem.uploadFromTemp(this.fileSystem.getTempFilePath(this.pathId), this.pathId);
                this.lastUploadTime = Date.now();
            }
        }, 30000);
    }

    public async close() {
        if (this.uploadInterval) {
            clearInterval(this.uploadInterval);
            this.uploadInterval = undefined;
        }
        this._db.close();
        await this.fileSystem.uploadFromTemp(this.fileSystem.getTempFilePath(this.pathId), this.pathId);
    }

    // Add this helper method
    private async hasFileChanged() {
        try {
            const dbPath = this.fileSystem.getTempFilePath(this.pathId);
            const dbStats = await Bun.file(dbPath).stat();
            const lastModified = dbStats?.mtime?.getTime();
            console.log('File changed', lastModified, this.lastUploadTime, lastModified > this.lastUploadTime);
            return lastModified > this.lastUploadTime;
        } catch (error) {
            console.error("Error checking if file changed:", error);
            return false;
        }
    }
}