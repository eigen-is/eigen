import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import { orgOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_FORMAT_VERSION } from '@workspace/lib/validation';
import { stageAuthDbCopy } from '../auth/auth';
import {
    CERT_FILES,
    getDataRoot,
    getServerDataPath,
    ORG_HOMES_DIR,
    SERVER_DATABASES,
    SERVER_FILES,
} from '../config/paths';
import { getOrgName, getPublicConfig } from '../config/server-config';
import { stageEigenDbCopy } from '../share/db';
import { stageWaitlistDbCopy } from '../waitlist/waitlist';
import type { ArchiveWriter } from './archive';
import { captureUnlessGone, captureWrittenFile } from './capture';
import {
    ARCHIVE_MANIFEST_FILE,
    archiveServerPath,
    buildServerFolderName,
    SERVER_ARCHIVE_CERTS_DIR,
    SERVER_ARCHIVE_DKIM_DIR,
    SERVER_ARCHIVE_ENV_MEMBER,
} from './paths';
import { listFileTree, type SnapshotProgress } from './snapshot-home';

type ServerDatabase = (typeof SERVER_DATABASES)[keyof typeof SERVER_DATABASES];

// Each server database is copied with VACUUM INTO through the handle the running server writes
// with, so the copy is one committed state. Keyed by file name: a database added to SERVER_DATABASES
// does not compile until it is staged here.
const STAGE_SERVER_DATABASE: Record<ServerDatabase, (destPath: string) => void | Promise<void>> = {
    [SERVER_DATABASES.users]: stageAuthDbCopy,
    [SERVER_DATABASES.shares]: stageEigenDbCopy,
    [SERVER_DATABASES.waitlist]: stageWaitlistDbCopy,
};

// Writes the server's own data into `{targetDir}/server-{stamp}/`, laid out as in data/: `server/`
// holds the databases and SERVER_FILES by name, so runtime files and strays stay out, and `org/` is
// the org folder as plain files. Packed and verified like a home; the manifest's kind is 'server'.
export async function snapshotServer(
    targetDir: string,
    at: Date,
    onProgress?: SnapshotProgress,
): Promise<BackupManifest> {
    const folder = path.join(targetDir, buildServerFolderName(at));
    fs.mkdirSync(folder, { recursive: true });
    const entries: BackupEntry[] = [];

    let databases = 0;
    const stagers = Object.entries(STAGE_SERVER_DATABASE);
    for (const [index, [name, stage]] of stagers.entries()) {
        // waitlist.db is created the first time the waitlist is used; staging would create it empty.
        if (fs.existsSync(getServerDataPath(name))) {
            const destPath = path.join(folder, archiveServerPath(name));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            await stage(destPath);
            entries.push(await captureWrittenFile(destPath, archiveServerPath(name)));
            databases++;
        }
        onProgress?.('server databases', index + 1, stagers.length);
    }

    const copies: { source: string; rel: string }[] = [];
    const copyTree = async (sourceDir: string, relDir: string): Promise<void> => {
        const tree = await listFileTree(sourceDir);
        // None of these folders holds a database (an org home has no drive to open one), and a file
        // copy of a live one is torn: one there is a new subsystem this snapshot has to learn.
        const [database] = tree.databases;
        if (database) throw new Error(`snapshotServer: database ${relDir}/${database} in a folder copied as files`);
        for (const rel of tree.dirs) fs.mkdirSync(path.join(folder, relDir, rel), { recursive: true });
        for (const rel of tree.files) copies.push({ source: path.join(sourceDir, rel), rel: `${relDir}/${rel}` });
    };
    for (const name of Object.values(SERVER_FILES)) {
        const source = getServerDataPath(name);
        if (!fs.existsSync(source)) continue;
        if (fs.statSync(source).isDirectory()) await copyTree(source, archiveServerPath(name));
        else copies.push({ source, rel: archiveServerPath(name) });
    }
    const orgDir = path.join(getDataRoot(), ORG_HOMES_DIR);
    if (fs.existsSync(orgDir)) await copyTree(orgDir, ORG_HOMES_DIR);
    for (const [index, { source, rel }] of copies.entries()) {
        // An avatar replaced mid-capture is gone by the time it is copied.
        const captured = await captureUnlessGone(Bun.file(source), path.join(folder, rel), rel);
        if (captured) entries.push(captured);
        onProgress?.('server files', index + 1, copies.length);
    }

    const config = getPublicConfig();
    const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        kind: 'server',
        ownerId: orgOwnerId(config.orgId),
        name: getOrgName(),
        createdAt: new Date().toISOString(),
        appVersion: config.version,
        server: { domain: config.domain, orgId: config.orgId },
        counts: {
            databases,
            files: entries.length - databases,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        },
        mounts: [],
        entries,
    };
    await Bun.write(path.join(folder, ARCHIVE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    return manifest;
}

function isReadable(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

// `names` in `dir` when every one of them is readable, else none: a key without its DNS record or its
// certificate restores nothing.
function readableFiles(dir: string, names: string[]): string[] {
    return names.every((name) => isReadable(path.join(dir, name))) ? names : [];
}

// The files of a folder. No folder means mail is off.
function listFiles(dir: string): string[] {
    if (!isReadable(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
}

// `.env.production`, the DKIM key and the TLS key sit outside data/ or belong to other users, so the API takes
// what it has been let read. What it cannot read stays out and the manifest says so: a restore then keeps the
// install's own env file, key and certificate, and a move to another machine needs new DKIM DNS and a new
// certificate. `envFile` is unset in `bun run dev`.
export async function appendInstallFiles(
    writer: ArchiveWriter,
    { envFile, dkimDir, certsDir }: { envFile?: string; dkimDir: string; certsDir: string },
): Promise<{ envFile: boolean; dkim: boolean; certs: boolean }> {
    const hasEnvFile = envFile !== undefined && isReadable(envFile);
    if (hasEnvFile) await writer.appendFile(SERVER_ARCHIVE_ENV_MEMBER, envFile);
    const folders = [
        { member: SERVER_ARCHIVE_DKIM_DIR, dir: dkimDir, names: readableFiles(dkimDir, listFiles(dkimDir)) },
        { member: SERVER_ARCHIVE_CERTS_DIR, dir: certsDir, names: readableFiles(certsDir, Object.values(CERT_FILES)) },
    ];
    for (const { member, dir, names } of folders) {
        for (const name of names) await writer.appendFile(`${member}/${name}`, path.join(dir, name));
    }
    const [dkim, certs] = folders.map(({ names }) => names.length > 0);
    return { envFile: hasEnvFile, dkim, certs };
}
