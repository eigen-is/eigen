import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import { orgOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_FORMAT_VERSION } from '@workspace/lib/validation';
import { getAuthDrizzleDb } from '../auth/auth';
import { getDataRoot, getServerDataPath, ORG_HOMES_DIR, SERVER_DATABASES, SERVER_FILES } from '../config/paths';
import { getOrgName, getPublicConfig } from '../config/server-config';
import { stageEigenDbCopy } from '../share/db';
import { stageWaitlistDbCopy } from '../waitlist/waitlist';
import type { ArchiveWriter } from './archive';
import { captureUnlessGone, captureWrittenFile } from './capture';
import {
    ARCHIVE_MANIFEST_FILE,
    archiveServerPath,
    buildServerFolderName,
    SERVER_ARCHIVE_DKIM_DIR,
    SERVER_ARCHIVE_ENV_MEMBER,
} from './paths';
import type { SnapshotProgress } from './snapshot-home';

type ServerDatabase = (typeof SERVER_DATABASES)[keyof typeof SERVER_DATABASES];

// Each server database is copied with VACUUM INTO through the handle the running server writes
// with, so the copy is one committed state. Keyed by file name: a database added to SERVER_DATABASES
// does not compile until it is staged here.
const STAGE_SERVER_DATABASE: Record<ServerDatabase, (destPath: string) => Promise<void>> = {
    [SERVER_DATABASES.users]: async (destPath) => {
        getAuthDrizzleDb().$client.run('VACUUM INTO ?', [destPath]);
    },
    [SERVER_DATABASES.shares]: stageEigenDbCopy,
    [SERVER_DATABASES.waitlist]: stageWaitlistDbCopy,
};

type FileTree = { files: string[]; dirs: string[] };

// Every file and directory under `dir`, relative to it. Directories are listed so an empty one
// survives the archive, as in a home.
function listTree(dir: string, relDir: string, out: FileTree): void {
    for (const entry of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.dirs.push(rel);
            listTree(dir, rel, out);
        } else if (entry.isFile()) {
            out.files.push(rel);
        }
    }
}

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
    const copyTree = (sourceDir: string, relDir: string): void => {
        const tree: FileTree = { files: [], dirs: [] };
        listTree(sourceDir, '', tree);
        for (const rel of tree.dirs) fs.mkdirSync(path.join(folder, relDir, rel), { recursive: true });
        for (const rel of tree.files) copies.push({ source: path.join(sourceDir, rel), rel: `${relDir}/${rel}` });
    };
    for (const name of Object.values(SERVER_FILES)) {
        const source = getServerDataPath(name);
        if (!fs.existsSync(source)) continue;
        if (fs.statSync(source).isDirectory()) copyTree(source, archiveServerPath(name));
        else copies.push({ source, rel: archiveServerPath(name) });
    }
    const orgDir = path.join(getDataRoot(), ORG_HOMES_DIR);
    if (fs.existsSync(orgDir)) copyTree(orgDir, ORG_HOMES_DIR);
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

// The DKIM folder's files when every one of them is readable, else none: a key without its record
// or a record without its key restores nothing. No folder means mail is off.
function readableKeyFiles(dkimDir: string): string[] {
    if (!isReadable(dkimDir)) return [];
    const names = fs
        .readdirSync(dkimDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    return names.every((name) => isReadable(path.join(dkimDir, name))) ? names : [];
}

// `.env.production` and the DKIM key sit outside data/ or belong to other users, so the API takes
// what it has been let read. What it cannot read stays out and the manifest says so: a restore then
// keeps the install's own env file, and a move to another machine needs new DKIM DNS. `envFile` is
// unset in `bun run dev`.
export async function appendInstallFiles(
    writer: ArchiveWriter,
    { envFile, dkimDir }: { envFile?: string; dkimDir: string },
): Promise<{ envFile: boolean; dkim: boolean }> {
    const hasEnvFile = envFile !== undefined && isReadable(envFile);
    if (hasEnvFile) await writer.appendFile(SERVER_ARCHIVE_ENV_MEMBER, envFile);
    const keyFiles = readableKeyFiles(dkimDir);
    for (const name of keyFiles) {
        await writer.appendFile(`${SERVER_ARCHIVE_DKIM_DIR}/${name}`, path.join(dkimDir, name));
    }
    return { envFile: hasEnvFile, dkim: keyFiles.length > 0 };
}
