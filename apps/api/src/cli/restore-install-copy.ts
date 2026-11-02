// Root's copies of the install folders a whole-server restore swaps in, the DKIM key and the mail TLS certificate.
// The swap of ./eigen restore runs as root, and the staged tree is the API user's, so root writes nothing into it. It
// copies each folder into a folder only root writes, giving every file the owner and mode the mail containers gave
// the one here, and the swap renames the copies in. Only plain files and folders are copied, and no hard link: one in
// the staged tree could be a live root-only file, such as the TLS key, that root would copy under a public file's mode.

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
    readSync,
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

// A key or a certificate fits in this many times over. A bigger file was planted, and root reads each file whole.
const MAX_COPIED_FILE_BYTES = 1024 * 1024;

// The DKIM key and the TLS certificate are a handful of files. More entries were planted to keep root busy.
const MAX_COPIED_ENTRIES = 1000;

// What the swap renames before the staged tree becomes data/, and after.
type InstallRenames = Record<'out' | 'in', [string, string][]>;

// The owner and permission bits an entry root copies gets.
type CopyOwner = (rel: string, found: Stats) => Owner & { mode: number };

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
    const copied = { entries: 0 };
    for (const { dir } of INSTALL_FOLDERS) {
        const [staged, here, copy] = [join(stagedData, dir), join(DATA, dir), join(INSTALL_COPIES, dir)];
        const fromArchive = lstatSync(staged, { throwIfNoEntry: false }) !== undefined;
        if (!fromArchive && !lstatSync(here, { throwIfNoEntry: false })) continue;
        const refused = fromArchive
            ? copyFolder(staged, copy, ownedLike(here), copied)
            : copyFolder(here, copy, ownOwner, copied);
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

// A file from the archive gets the owner and mode of the one it replaces here, or keeps its own when there is none.
// Its own owner says nothing of who wrote it: Docker Desktop shows every file of a bind mount as the reader's.
function ownedLike(here: string): CopyOwner {
    return (rel, found) => {
        const replaced = lstatSync(join(here, rel), { throwIfNoEntry: false });
        const same = replaced && replaced.isFile() === found.isFile() && replaced.isDirectory() === found.isDirectory();
        return ownOwner(rel, same ? replaced : found);
    };
}

// Root's copy of the folder `from` into `to`, which must not exist yet. Each entry gets the owner and mode `ownerOf`
// gives it, without a setuid, setgid or sticky bit. A link, a hard link, a device, a FIFO or a socket, a setuid or
// setgid file and a file bigger than a key are refused with the reason. So is any entry once `copied`, the count over
// every folder root copies, passes MAX_COPIED_ENTRIES. A file is opened without following a link and must be the file the walk found, so a file swapped for a
// link meanwhile is not read. A folder is not guarded that way: one swapped for a link between its check and its
// listing leads the walk to wherever the link points.
function copyFolder(
    from: string,
    to: string,
    ownerOf: CopyOwner,
    copied: { entries: number },
    rel = '',
): string | null {
    const path = join(from, rel);
    const target = join(to, rel);
    copied.entries += 1;
    if (copied.entries > MAX_COPIED_ENTRIES) return `${path} is past the ${MAX_COPIED_ENTRIES} entries root copies`;
    const found = lstatSync(path);
    if (found.isDirectory()) {
        mkdirSync(target, { mode: 0o700 });
        for (const name of readdirSync(path)) {
            const refused = copyFolder(from, to, ownerOf, copied, join(rel, name));
            if (refused) return refused;
        }
    } else if (found.isFile()) {
        if (found.mode & 0o6000) return `${path} is setuid or setgid`;
        if (found.nlink > 1) return `${path} is a hard link`;
        const bytes = readFound(path, found);
        if (typeof bytes === 'string') return `${path} ${bytes}`;
        writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    } else {
        return `${path} is ${found.isSymbolicLink() ? 'a link' : 'not a file or a folder'}`;
    }
    const owner = ownerOf(rel, found);
    ownAs(target, owner);
    // A folder's mode last, as one without write permission takes no files.
    chmodSync(target, owner.mode);
    return null;
}

// The bytes of the file at `path`, or why they are not copied. The read stops one byte past the cap, so a file that
// grows while it is read is refused as well. The link count is checked again on the open file, since a hard link
// may have been made since the walk found it.
function readFound(path: string, found: Stats): Buffer | string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = fstatSync(fd);
        if (opened.ino !== found.ino || opened.dev !== found.dev) return 'changed while it was copied';
        if (opened.nlink > 1) return 'is a hard link';
        const bytes = Buffer.alloc(MAX_COPIED_FILE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = readSync(fd, bytes, length, bytes.length - length, length);
            if (read === 0) break;
            length += read;
        }
        return length > MAX_COPIED_FILE_BYTES ? 'is bigger than a key or a certificate' : bytes.subarray(0, length);
    } finally {
        closeSync(fd);
    }
}
