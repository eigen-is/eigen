import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProduction } from './env';

export function getDataRoot(): string {
    const envRoot = process.env['EIGEN_DATA_ROOT'];
    if (envRoot) return envRoot;

    if (isProduction()) {
        throw new Error(
            'EIGEN_DATA_ROOT environment variable is required in production. ' +
                'Set it to the absolute path of your data directory (e.g. /home/user/eigen/data).',
        );
    }

    return './../../data';
}

// The server's own folder in data/, beside the homes.
export const SERVER_DIR = 'server';

export function getServerDataPath(filename?: string): string {
    const serverData = path.join(getDataRoot(), SERVER_DIR);
    if (!fs.existsSync(serverData)) {
        fs.mkdirSync(serverData, { recursive: true });
    }
    return filename ? path.join(serverData, filename) : serverData;
}

// The image points this outside data/, so the socket never lands in a snapshot or on a host bind mount.
export function getControlSocketPath(): string {
    return process.env['EIGEN_CONTROL_SOCKET'] ?? getServerDataPath('control.sock');
}

export function getAvatarsDir(): string {
    const avatarsDir = path.join(getServerDataPath(), 'avatars');
    if (!fs.existsSync(avatarsDir)) {
        fs.mkdirSync(avatarsDir, { recursive: true });
    }
    return avatarsDir;
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

export function getGuestHomePath(userId: string): string {
    return path.join(getDataRoot(), 'guest', userId);
}
