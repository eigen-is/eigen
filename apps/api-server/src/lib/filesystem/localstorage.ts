import type {Storage} from "./storage";
import {type BunFile, type S3File} from 'bun';
import * as path from "path";
import * as fs from "node:fs";
import type {User} from "better-auth/types";
import { getUserHomePath } from "../config/paths";

export class LocalStorage implements Storage {
    private user: User;
    private userDir: string;
    private baseDir: string;

    constructor(user: User, baseDir: string) {
        this.user = user;
        this.baseDir = baseDir;
        const userHomePath = getUserHomePath(user.id);
        this.userDir = path.join(userHomePath, baseDir, 'data');
        if (!fs.existsSync(this.userDir)) {
            fs.mkdirSync(this.userDir, {recursive: true});
        }
    }

    private generateKey(pathId: string): string {
        return `${pathId}.${this.baseDir}.${this.user.id}`;
    }

    public async write(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<boolean> {
        const fileName = this.generateKey(pathId);
        return await Bun.write(path.join(this.userDir, fileName), data, {createPath: true}) > 0;
    }

    public file(pathId: string): S3File | BunFile {
        const fileName = this.generateKey(pathId);
        return Bun.file(path.join(this.userDir, fileName));
    }

    public async delete(pathId: string): Promise<boolean> {
        try {
            await this.file(pathId)?.delete();
            return true;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to delete file ${pathId}: ${errorMessage}`);
            return false;
        }
    }

    public async exists(pathId: string): Promise<boolean> {
        return this.file(pathId)?.exists() ?? false;
    }
}