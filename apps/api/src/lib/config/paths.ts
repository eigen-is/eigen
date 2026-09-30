import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { DATA_LOCK_FILE } from './data-lock';
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
// The folders in data/ that hold one home each, by owner kind.
export const USER_HOMES_DIR = 'home';
export const TEAM_HOMES_DIR = 'team';
export const ORG_HOMES_DIR = 'org';
export const GUEST_HOMES_DIR = 'guest';
// The DKIM key and its DNS record, which the postfix container generates in data/ and owns.
export const DKIM_DIR = 'dkim';
// The mail server's TLS certificate, which Caddy's export-certs.sh or the operator's certbot hook copies in.
export const CERTS_DIR = 'certs';
export const CERT_FILES = { cert: 'cert.pem', key: 'key.pem' } as const;

// What a server backup takes from SERVER_DIR, by name: the databases through their live handles, the rest as files.
export const SERVER_DATABASES = { users: 'users3.db', shares: 'eigen.db', waitlist: 'waitlist.db' } as const;
export const SERVER_FILES = { config: 'config.json', settings: 'settings.json', avatars: 'avatars' } as const;
// Written by the running server, never captured, never restored.
export const SERVER_RUNTIME_FILES = {
    instanceLock: DATA_LOCK_FILE,
    controlSocket: 'control.sock',
    setupToken: 'setup-token',
    epoch: 'data-epoch',
    homeEpochs: 'home-data-epochs.json',
} as const;

export function getServerDataPath(filename?: string): string {
    const serverData = path.join(getDataRoot(), SERVER_DIR);
    if (!fs.existsSync(serverData)) {
        fs.mkdirSync(serverData, { recursive: true });
    }
    return filename ? path.join(serverData, filename) : serverData;
}

// The image points this outside data/, so the socket never lands in a snapshot or on a host bind mount.
export function getControlSocketPath(): string {
    return process.env['EIGEN_CONTROL_SOCKET'] ?? getServerDataPath(SERVER_RUNTIME_FILES.controlSocket);
}

export function getAvatarsDir(): string {
    const avatarsDir = path.join(getServerDataPath(), SERVER_FILES.avatars);
    if (!fs.existsSync(avatarsDir)) {
        fs.mkdirSync(avatarsDir, { recursive: true });
    }
    return avatarsDir;
}

// A user's or a team's home folder under a data root: the live one, or a tree a restore stages.
export function homeDirUnder(dataRoot: string, ownerId: string): string {
    const owner = parseOwnerId(ownerId);
    return path.join(dataRoot, owner.type === 'team' ? TEAM_HOMES_DIR : USER_HOMES_DIR, owner.id);
}

export function getUserHomePath(userId: string): string {
    return path.join(getDataRoot(), USER_HOMES_DIR, userId);
}

export function getTeamDataPath(teamId: string): string {
    return path.join(getDataRoot(), TEAM_HOMES_DIR, teamId);
}

export function getOrgDataPath(orgId: string): string {
    return path.join(getDataRoot(), ORG_HOMES_DIR, orgId);
}

export function getGuestHomePath(userId: string): string {
    return path.join(getDataRoot(), GUEST_HOMES_DIR, userId);
}
