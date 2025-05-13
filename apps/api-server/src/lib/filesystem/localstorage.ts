import type { Storage } from "./storage";
import {type BunFile, type S3File} from 'bun';
import * as path from "path";
import * as fs from "node:fs/promises";
import type {User} from "better-auth/types";

export class LocalStorage implements Storage {
    private user: User;
    private userDir: string;
    private prefix: string;

    constructor(user: User, prefix: string) {
        this.user = user;
        this.prefix = prefix;
        this.userDir = `./data/bucket/${this.user.id}/${this.prefix}/`;

        fs.mkdir(this.userDir, { recursive: true });
    }

    private generateKey(pathId: string): string {
        return `${pathId}.${this.prefix}.${this.user.id}`;
    }

    public async uploadFile(pathId: string, data: Buffer | Uint8Array | BunFile | S3File | ArrayBuffer): Promise<void> {
        const fileName = this.generateKey(pathId);
        await Bun.write(path.join(this.userDir, fileName), data);
    }

    public getFile(pathId: string): S3File | BunFile {
        const fileName = this.generateKey(pathId);
        return Bun.file(path.join(this.userDir, fileName));
    }

    public async deleteFile(pathId: string): Promise<void> {
        await this.getFile(pathId)?.delete();
    }

    public async fileExists(pathId: string): Promise<boolean> {
        return this.getFile(pathId)?.exists() ?? false;
    }
}