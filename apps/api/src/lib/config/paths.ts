import * as path from "path";
import * as fs from "node:fs";
import {isProduction} from './env';

function getDataRoot(): string {
    const envRoot = process.env['EIGEN_DATA_ROOT'];
    if (envRoot) return envRoot;

    if (isProduction()) {
        throw new Error(
            'EIGEN_DATA_ROOT environment variable is required in production. ' +
            'Set it to the absolute path of your data directory (e.g. /home/user/eigen/data).'
        );
    }

    return './../../data';
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

export function getTeamDataPath(teamId: string): string {
    return path.join(getDataRoot(), 'team', teamId);
}

export function getOrgDataPath(orgId: string): string {
    return path.join(getDataRoot(), 'org', orgId);
}