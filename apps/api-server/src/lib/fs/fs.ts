import {User} from "better-auth/types";
import {mkdir} from "node:fs/promises";
import Database from "bun:sqlite";

export async function fsGetFileName(user: User, file: string): Promise<string> {
    const path = `./data/home/${user.id}/${file}`;
    // get directory name
    const parts = path.split("/");
    parts.pop();
    const dir = parts.join("/");
    // create directory if not exists
    await mkdir(dir, {recursive: true});

    return path;
}

export async function fsGetDatabase(user: User, file: string, create: boolean = true, onCreate = async (db: Database) => {}) {
    const path = await fsGetFileName(user, file);
    const bunfile = Bun.file(path);
    if (await bunfile.exists()) {
        return new Database(path);
    } else if (create) {
        const db = new Database(path, {create});
        await onCreate(db);
        return db;
    }
    throw new Error(`File not found: ${path}`);
}

export function fsGetDirName(user: User, dir: string): string {
    return `./data/home/${user.id}/${dir}`;
}