import * as path from "path";

const DATA_ROOT = './../../data';
const SERVER_DATA = path.join(DATA_ROOT, 'server');
const HOME_DATA = path.join(DATA_ROOT, 'home');

export function getServerDataPath(filename?: string): string {
    return filename ? path.join(SERVER_DATA, filename) : SERVER_DATA;
}

export function getUserHomePath(userId: string): string {
    return path.join(HOME_DATA, userId);
}

export function getHomeDataPath(): string {
    return HOME_DATA;
}
