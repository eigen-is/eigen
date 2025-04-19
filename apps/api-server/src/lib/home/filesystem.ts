import type {Home} from "./home";
import * as path from "path";
import * as fs from "node:fs/promises";
import {watch} from "node:fs";
import {Database} from "bun:sqlite";
import Bun, {type BunFile} from 'bun';

export default class FileSystem {
    private home: Home;
    private homeDir: string;

    constructor(home: Home) {
        this.home = home;
        this.homeDir = `./data/home/${home.user.id}/`;
    }

    public async init() {
        // Create the home directory if it doesn't exist
        await fs.mkdir(this.homeDir, {recursive: true});
    }

    /**
     * Creates directories
     * @param dirPath Path to create
     * @param options Options for mkdir
     */
    public async mkdir(dirPath: string, options: { recursive?: boolean } = {recursive: true}) {
        const absolutePath = this.makeAbsolutePath(dirPath);
        return await fs.mkdir(absolutePath, options);
    }

    /**
     * Lists directory contents
     * @param dirPath Directory to list
     * @param options Options for readdir
     */
    public async readdir(dirPath: string, options?: { withFileTypes?: boolean }) {
        const absolutePath = this.makeAbsolutePath(dirPath);
        return await fs.readdir(absolutePath, options);
    }

    public async fileMeta(path: string): Promise<{ file: BunFile | null, size: number, type: string }> {
        const file = this.file(path);
        if (file) {
            // @ts-ignore
            return {file, size: file.size, type: file.type};
        } else {
            return {file: null, size: 0, type: ''};
        }
    }

    /**
     * Gets file/directory information
     * @param path Path to get info for
     */
    public async stat(path: string) {
        const absolutePath = this.makeAbsolutePath(path);
        return await fs.stat(absolutePath);
    }

    /**
     * Moves/renames files
     * @param oldPath Old path
     * @param newPath New path
     */
    public async rename(oldPath: string, newPath: string) {
        const absoluteOldPath = this.makeAbsolutePath(oldPath);
        const absoluteNewPath = this.makeAbsolutePath(newPath);
        return await fs.rename(absoluteOldPath, absoluteNewPath);
    }

    /**
     * Deletes files
     * @param filePath Path to delete
     */
    public async unlink(filePath: string) {
        const absolutePath = this.makeAbsolutePath(filePath);
        return await fs.unlink(absolutePath);
    }

    public async rm(filePath: string, options: { recursive: true, force: true }) {
        const absolutePath = this.makeAbsolutePath(filePath);
        return await fs.rm(absolutePath, options);
    }

    /**
     * Returns a Bun file object with extended methods
     * @param filePath Path to file
     */
    public file(filePath: string) {
        const absolutePath = this.makeAbsolutePath(filePath);
        return Bun.file(absolutePath);
    }

    public async writeFile(filePath: string, data: string | ArrayBuffer | SharedArrayBuffer | BunFile) {
        // get size of data
        // @ts-ignore
        const size = typeof data === 'string' ? data.length : ((data as BunFile).size) || (data as ArrayBuffer).byteLength;
        const stats = await this.home.size();
        const sizeAvailable = stats.max - stats.used;
        if (size < sizeAvailable) {
            return await this.file(filePath).write(data);
        } else {
            throw new Error('Not enough space');
        }
    }

    /**
     * Watches a directory or file for changes
     * @param path Path to watch
     * @param callback Callback to call when changes are detected
     */
    public watch(path: string, callback: (eventType: string, filename: string | null) => void) {
        const absolutePath = this.makeAbsolutePath(path);
        return watch(absolutePath, callback);
    }

    /**
     * Joins path segments
     * @param paths Path segments to join
     */
    public pathJoin(...paths: string[]) {
        return path.join(...paths);
    }

    /**
     * Gets the base name of a path
     * @param filePath Path to get basename from
     * @param ext Optional extension to remove
     */
    public pathBasename(filePath: string, ext?: string) {
        return path.basename(filePath, ext);
    }

    /**
     * Checks if a file exists
     * @param filePath Path to check
     */
    public async fileExists(filePath: string) {
        const absolutePath = this.makeAbsolutePath(filePath);
        try {
            const stats = await fs.stat(absolutePath);
            return stats.isFile();
        } catch (error) {
            return false;
        }
    }

    /**
     * Checks if a directory exists
     * @param dirPath Path to check
     */
    public async dirExists(dirPath: string) {
        const absolutePath = this.makeAbsolutePath(dirPath);
        try {
            const stats = await fs.stat(absolutePath);
            return stats.isDirectory();
        } catch (error) {
            return false;
        }
    }

    /**
     * Creates and opens a SQLite database
     * @param dbPath Path to database
     * @param create Whether to create the database if it doesn't exist
     * @param onCreate Callback to run when creating a new database
     */
    public async createAndOpenDatabase(dbPath: string, create: boolean = true, onCreate: (db: Database) => Promise<void> = async () => {
    }) {
        const absolutePath = this.makeAbsolutePath(dbPath);

        // Ensure the directory exists
        const dirPath = path.dirname(absolutePath);
        await fs.mkdir(dirPath, {recursive: true});

        const bunfile = Bun.file(absolutePath);
        if (await bunfile.exists()) {
            const db = new Database(absolutePath);
            db.exec("PRAGMA journal_mode = WAL;");
            db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
            return db;
        } else if (create) {
            const db = new Database(absolutePath, {create});
            await onCreate(db);
            db.exec("PRAGMA journal_mode = WAL;");
            db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
            return db;
        }
        throw new Error(`Database not found: ${absolutePath}`);
    }

    public absolutePath(path: string) {
        return this.makeAbsolutePath(path);
    }

    public async dirSize(path: string): Promise<number> {
        const systemPath = this.makeAbsolutePath(path);

        // Detect if we're running on Linux
        const isLinux = process.platform === 'linux';
        console.log(`Checking size of ${systemPath} on ${isLinux ? 'Linux' : 'other'}`);

        if (isLinux) {
            // Linux-specific implementation
            // For example, you might use the `du` command with child_process
            try {
                const proc = Bun.spawn(["du", "-sb", systemPath]);
                const stdout = await new Response(proc.stdout).text();
                const sizeInBytes = parseInt(stdout.split('\t')[0], 10);
                return sizeInBytes;
            } catch (error) {
                console.error("Error calculating size on Linux:", error);
                return 0;
            }
        } else {
            const dirSize = async (dir: string): Promise<number> => {
                const files = await fs.readdir(dir, {withFileTypes: true});

                const paths = files.map(async file => {
                    const path = this.pathJoin(dir, file.name);
                    if (file.isDirectory()) return await dirSize(path);
                    if (file.isFile()) {
                        const {size} = await fs.stat(path);
                        return size;
                    }
                    return 0;
                });
                return (await Promise.all(paths)).flat(Infinity).reduce((i, size) => i + size, 0);
            }
            return await dirSize(systemPath);
        }
    }

    private makeAbsolutePath(path: string) {
        // Make sure that path stays inside this.homeDir
        const normalizedPath = path.replace(/\.\.\//g, ''); // Remove any "../" to prevent directory traversal
        return `${this.homeDir}${normalizedPath}`;
    }

    private async createZip(): Promise<string> {
        const zipPath = `/tmp/${this.home.user.id}.tar.gz`;

        try {
            // Check if we need to create a new zip (if it doesn't exist or is older than 1 hour)
            let needToCreate = true;
            try {
                const stats = await fs.stat(zipPath);
                const fileAge = Date.now() - stats.mtime.getTime();
                // If the file is less than 1 hour old, we don't need to create a new one
                if (fileAge < 60 * 60 * 1000) {
                    needToCreate = false;
                }
            } catch (err) {
                // File doesn't exist, we need to create it
            }

            if (needToCreate) {
                // Create a tar.gz of the home directory
                // -C changes to the directory before zipping
                // -c creates a new archive
                // -z compresses with gzip
                // -f specifies the output file
                const cmd = `tar -czf ${zipPath} -C ${path.dirname(this.homeDir)} ${path.basename(this.homeDir)}`;

                // Execute the command using Bun
                const proc = Bun.spawn(["sh", "-c", cmd]);
                const exitCode = await proc.exited;

                if (exitCode !== 0) {
                    throw new Error(`Failed to create zip file: exit code ${exitCode}`);
                }
            }

            return zipPath;
        } catch (error) {
            console.error('Error creating zip file:', error);
            throw error;
        }
    }

    /**
     * Gets the gzip archive of the user's home directory
     * Creates the archive if it doesn't exist or is outdated
     * @returns An object containing the file path and a blob with the file contents
     */
    public async getZip() {
        try {
            // Create or get the cached zip file
            const zipPath = await this.createZip();

            // Read the file contents
            const fileContents = await Bun.file(zipPath).arrayBuffer();

            return {
                fileName: `${this.home.user.id}-home.tar.gz`,
                contentType: "application/gzip",
                data: new Uint8Array(fileContents)
            };
        } catch (error) {
            console.error('Error getting zip file:', error);
            throw error;
        }
    }
}