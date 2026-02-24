import * as path from "path";
import * as fs from "node:fs";

function getDataRoot(): string {
    return process.env['EIGEN_DATA_ROOT'] || './../../data';
}

export function getServerDataPath(filename?: string): string {
    const serverData = path.join(getDataRoot(), 'server');
    if (!fs.existsSync(serverData)) {
        fs.mkdirSync(serverData, {recursive: true});
    }
    return filename ? path.join(serverData, filename) : serverData;
}

export function getUserHomePath(userId: string): string {
    return path.join(getDataRoot(), 'home', userId);
}

export function getHomeDataPath(): string {
    return path.join(getDataRoot(), 'home');
}
