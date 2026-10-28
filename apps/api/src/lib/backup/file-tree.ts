// Walks a folder the way a backup captures it: its plain files, every directory, and its databases, which a
// capture copies through their live handle and never as files. treeBytes sizes the same walk for the room check
// before a server backup. Journal files belong to the running server, so neither counts them.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isEnoent } from '../core';

// Databases are captured with VACUUM INTO through the live handle, never as a file copy, and their
// journals belong to the running server.
const DB_FILE = /\.db(-wal|-shm)?$/;
const JOURNAL_FILE = /\.db-(wal|shm)$/;

// A folder as its plain files, its databases and every directory. The directories count because an empty Maildir
// `new/` holds no file that implies it, and a restored mailbox without it gives MaildirStore.watch nothing to watch.
type FileTree = { files: string[]; dirs: string[]; databases: string[] };

// Synchronous to narrow the window in which the mail watcher's move from `new/` to `cur/` hides a message from a capture.
export function listFileTree(root: string, skipDir: (rel: string) => boolean = () => false): FileTree {
    const tree: FileTree = { files: [], dirs: [], databases: [] };
    const walk = (relDir: string): void => {
        for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (skipDir(rel)) continue;
                tree.dirs.push(rel);
                walk(rel);
            } else if (entry.isFile()) {
                if (!DB_FILE.test(entry.name)) tree.files.push(rel);
                else if (entry.name.endsWith('.db')) tree.databases.push(rel);
            }
        }
    };
    walk('');
    return tree;
}

// What a capture of the tree stages, at most: its files and databases as they sit on disk. The room check before a
// server backup sizes every home with it while the server runs, so a file or folder gone since its listing counts
// nothing. A folder's files are statted together, its subfolders walked one at a time to keep few handles open.
export async function treeBytes(root: string, skipDir: (rel: string) => boolean = () => false): Promise<number> {
    const walk = async (relDir: string): Promise<number> => {
        const entries = await fsp
            .readdir(path.join(root, relDir), { withFileTypes: true })
            .catch((error) => (isEnoent(error) ? [] : Promise.reject(error)));
        const rel = (name: string) => (relDir ? `${relDir}/${name}` : name);
        const files = entries.filter((entry) => entry.isFile() && !JOURNAL_FILE.test(entry.name));
        const sizes = await Promise.all(
            files.map((entry) =>
                fsp.stat(path.join(root, rel(entry.name))).then(
                    (stat) => stat.size,
                    (error) => (isEnoent(error) ? 0 : Promise.reject(error)),
                ),
            ),
        );
        let bytes = sizes.reduce((sum, size) => sum + size, 0);
        for (const entry of entries) {
            if (entry.isDirectory() && !skipDir(rel(entry.name))) bytes += await walk(rel(entry.name));
        }
        return bytes;
    };
    return walk('');
}
