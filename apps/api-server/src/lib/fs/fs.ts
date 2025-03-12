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

export async function fsGetDatabase(user: User, file: string, create: boolean = true) {
    const path = await fsGetFileName(user, file);
    return new Database(path, {create});
}