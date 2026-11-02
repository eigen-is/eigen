// Root's copies of the install folders a whole-server restore swaps in, the DKIM key and the mail TLS certificate.
// The swap of ./eigen restore runs as root, and the staged tree is the API user's, so root writes nothing into it. It
// copies each folder into a folder only root writes, giving every file the owner and mode the mail containers gave
// the one here, and the swap renames the copies in.

import type { Stats } from 'node:fs';
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { INSTALL_FOLDERS } from '../lib/backup/paths';
import type { Owner } from './install';
import { DATA, ownAs } from './install';
import type { Ui } from './ui';

// Where root makes the copies, until the swap moves them in.
export const INSTALL_COPIES = '.eigen/restore-install';

// What the swap renames before the staged tree becomes data/, and after.
type InstallRenames = Record<'out' | 'in', [string, string][]>;

// The owner and permission bits an entry root copies gets, or why it is refused.
type CopyOwner = (rel: string, found: Stats) => (Owner & { mode: number }) | string;

// The DKIM key and the TLS certificate keep the owners and modes the mail containers gave the ones here, such as a key
// that root owns and group 1000 reads. Returns the renames that move the archive's folder out of the staged tree,
// before the staged tree becomes data/, and the copy into data/ after. An archive without one keeps the one here:
// mail would sign with a key DNS does not publish, and serve IMAP and SMTP with a self-signed certificate.
export function copyInstallFolders(ui: Ui, archive: string, stagedData: string): InstallRenames {
    const stage = lstatSync(stagedData);
    rmSync(INSTALL_COPIES, { recursive: true, force: true });
    mkdirSync(INSTALL_COPIES, { mode: 0o700 });
    if (statSync(INSTALL_COPIES).dev !== stage.dev) {
        ui.fail(`${INSTALL_COPIES} is on another disk than ${DATA}.`, `Move it onto the disk of ${DATA}.`);
    }
    const renames: InstallRenames = { out: [], in: [] };
    for (const { dir } of INSTALL_FOLDERS) {
        const [staged, here, copy] = [join(stagedData, dir), join(DATA, dir), join(INSTALL_COPIES, dir)];
        const fromArchive = lstatSync(staged, { throwIfNoEntry: false }) !== undefined;
        if (!fromArchive && !lstatSync(here, { throwIfNoEntry: false })) continue;
        const refused = fromArchive
            ? copyFolder(staged, copy, ownedLike(here, stage))
            : copyFolder(here, copy, ownOwner);
        if (refused) {
            ui.fail(
                `${archive} cannot be swapped in: ${refused}.`,
                'Put plain files and folders there, then run ./eigen restore again.',
            );
        }
        if (fromArchive) renames.out.push([staged, `${copy}.archived`]);
        renames.in.push([copy, join(DATA, dir)]);
    }
    return renames;
}

// An entry here keeps its own owner and mode.
const ownOwner: CopyOwner = (_, found) => ({ uid: found.uid, gid: found.gid, mode: found.mode & 0o777 });

// A file the stage wrote gets the owner and mode of the one it replaces here, or keeps its own when there is none.
// Only the stage's own files are copied: one of anybody else in the staged tree was put there.
function ownedLike(here: string, stage: Stats): CopyOwner {
    return (rel, found) => {
        if (found.uid !== stage.uid) return 'is not what the stage wrote';
        const replaced = lstatSync(join(here, rel), { throwIfNoEntry: false });
        const same = replaced && replaced.isFile() === found.isFile() && replaced.isDirectory() === found.isDirectory();
        return ownOwner(rel, same ? replaced : found);
    };
}

// Root's copy of the folder `from` into `to`, which must not exist yet. Each entry gets the owner and mode `ownerOf`
// gives it, without a setuid, setgid or sticky bit. A file is read through a descriptor of the file the walk found,
// so a path swapped for a link meanwhile is not read. A link, a device, a FIFO or a socket, and a setuid or setgid
// file, are refused with the reason.
function copyFolder(from: string, to: string, ownerOf: CopyOwner, rel = ''): string | null {
    const path = join(from, rel);
    const target = join(to, rel);
    const found = lstatSync(path);
    if (found.isDirectory()) {
        mkdirSync(target, { mode: 0o700 });
        for (const name of readdirSync(path)) {
            const refused = copyFolder(from, to, ownerOf, join(rel, name));
            if (refused) return refused;
        }
    } else if (found.isFile()) {
        if (found.mode & 0o6000) return `${path} is setuid or setgid`;
        const bytes = readFound(path, found);
        if (!bytes) return `${path} changed while it was copied`;
        writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    } else {
        return `${path} is ${found.isSymbolicLink() ? 'a link' : 'not a file or a folder'}`;
    }
    const owner = ownerOf(rel, found);
    if (typeof owner === 'string') return `${path} ${owner}`;
    ownAs(target, owner);
    // A folder's mode last, as one without write permission takes no files.
    chmodSync(target, owner.mode);
    return null;
}

// The bytes of the file at `path`, or null when it is no longer the file `found` describes.
function readFound(path: string, found: Stats): Buffer | null {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = fstatSync(fd);
        return opened.ino === found.ino && opened.dev === found.dev ? readFileSync(fd) : null;
    } finally {
        closeSync(fd);
    }
}
