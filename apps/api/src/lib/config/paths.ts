import * as path from "path";
import * as fs from "node:fs";

const DATA_ROOT = process.env['EIGEN_DATA_ROOT'] || './../../data';
const SERVER_DATA = path.join(DATA_ROOT, 'server');
const HOME_DATA = path.join(DATA_ROOT, 'home');

if (!fs.existsSync(SERVER_DATA)) {
    fs.mkdirSync(SERVER_DATA, {recursive: true});
}

export function getServerDataPath(filename?: string): string {
    return filename ? path.join(SERVER_DATA, filename) : SERVER_DATA;
}

export function getUserHomePath(userId: string): string {
    return path.join(HOME_DATA, userId);
}

export function getHomeDataPath(): string {
    return HOME_DATA;
}
