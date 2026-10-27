// Where Eigen keeps its files on disk. getDataRoot is the data folder; the server keeps its own files in
// one folder there, and each user, team, org and guest gets a home folder beside it. PATHS names the folders
// and databases inside one home. Every part of the server that opens a file, and every backup and restore,
// builds the path from these names, so the layout is written down once.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { DATA_LOCK_FILE } from './data-lock';
import { isProduction } from './env';

// The layout inside one home folder.
const DRIVE_ROOT = 'mounts';
const MAIL_ROOT = 'eigen.mail';
const CONTACTS_ROOT = 'eigen.contacts';
const CALENDAR_ROOT = 'eigen.calendar';

export const PATHS = {
    // At the root of every home folder, and so of every archive and safety copy of one.
    SETTINGS: 'settings.json',
    DRIVE: {
        ROOT: DRIVE_ROOT,
        DEFAULT_MOUNT: 'default',
        SHARED_DB: `${DRIVE_ROOT}/shared.db`,
        METADATA_DB: 'metadata.db',
        DATA_DIR: 'data',
        THUMBS_DIR: 'thumbs',
        TMP_DIR: 'tmp',
        STAGING_DIR: 'staging',
        PREVIEWS_DIR: 'previews',
        DOCS_DIR: 'docs',
    },
    MAIL: {
        ROOT: MAIL_ROOT,
        MAILDIR: 'Maildir',
        DB: `${MAIL_ROOT}/mail.db`,
        CUR: 'cur',
        NEW: 'new',
        TMP: 'tmp',
    },
    CONTACTS: {
        ROOT: CONTACTS_ROOT,
        DB: `${CONTACTS_ROOT}/contacts.db`,
        AVATARS: 'avatars',
    },
    CALENDAR: {
        ROOT: CALENDAR_ROOT,
        DB: `${CALENDAR_ROOT}/calendar.db`,
    },
    NOTIFICATIONS: {
        DB: 'eigen.notifications/notifications.db',
    },
} as const;

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
