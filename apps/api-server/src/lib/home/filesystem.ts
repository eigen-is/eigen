import type {Home} from "./home";
import * as path from "path";
import * as fs from "node:fs/promises";
import {watch} from "node:fs";
import {Database} from "bun:sqlite";
import Bun from 'bun';

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

    public async rm(filePath: string, options: {recursive: true, force: true}) {
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
            return new Database(absolutePath);
        } else if (create) {
            const db = new Database(absolutePath, {create});
            await onCreate(db);
            return db;
        }
        throw new Error(`Database not found: ${absolutePath}`);
    }

    private makeAbsolutePath(path: string) {
        // Make sure that path stays inside this.homeDir
        const normalizedPath = path.replace(/\.\.\//g, ''); // Remove any "../" to prevent directory traversal
        return `${this.homeDir}${normalizedPath}`;
    }
}