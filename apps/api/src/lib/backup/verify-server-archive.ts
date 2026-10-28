// Reads a whole-server archive back and checks it against the manifest it closes with, without unpacking a
// member: every member's size and sha256, or a single member for a reader that needs only that one. The server
// backup checks its archive this way once written, and ./eigen restore before it stages one.

import type { BackupVerifyRecord, ServerArchiveManifest } from '@workspace/lib/types/backup';
import { parseServerArchiveManifest } from '@workspace/lib/validation';
import type { ArchiveMember, ArchiveMemberAt } from './archive';
import { hashArchiveMembers, listArchiveMembers, readArchiveMember } from './archive';
import { describeError } from './errors';
import { ARCHIVE_MANIFEST_FILE } from './paths';
import { entryMismatch } from './verify';

// A whole-server archive as one read finds it: every member hashed, the manifest it closes with,
// and the transport verdict. The manifest is null unless it parses; the members are what the read
// got through before it failed.
type ReadServerArchive = {
    verify: BackupVerifyRecord;
    members: ArchiveMember[];
    manifest: ServerArchiveManifest | null;
};

// The transport check of a whole-server archive: its last member is the manifest, and every other
// member is there with the bytes and sha256 the manifest names. No member is unpacked; each one
// verifies on its own when it is extracted.
export async function readServerArchive(archivePath: string): Promise<ReadServerArchive> {
    const checkedAt = new Date();
    const failed = (
        failures: string[],
        members: ArchiveMember[] = [],
        manifest: ServerArchiveManifest | null = null,
    ): ReadServerArchive => ({ verify: { status: 'failed', checkedAt, failures }, members, manifest });
    let members: ArchiveMember[];
    try {
        members = await hashArchiveMembers(archivePath);
    } catch (error) {
        // A cut-off or foreign tar is a verdict on the archive, not an error of the check.
        return failed([describeError(error)]);
    }
    const manifest = await readClosingManifest(members);
    if (typeof manifest === 'string') return failed([manifest], members);

    // A reader takes one of two same-named members and the manifest cannot say which, so their bytes do not matter.
    const present = new Map<string, ArchiveMember>();
    const duplicates = new Set<string>();
    for (const member of members.slice(0, -1)) {
        if (present.has(member.name)) duplicates.add(member.name);
        present.set(member.name, member);
    }
    if (duplicates.size > 0) {
        const failures = [...duplicates].map((name) => `${name}: appears more than once in the archive`);
        return failed(failures, members, manifest);
    }

    const failures: string[] = [];
    for (const entry of manifest.entries) {
        const member = present.get(entry.path);
        present.delete(entry.path);
        if (!member) {
            failures.push(`${entry.path}: missing from the archive`);
        } else {
            const mismatch = entryMismatch(entry, member.bytes, member.sha256);
            if (mismatch) failures.push(mismatch);
        }
    }
    for (const extra of present.keys()) failures.push(`${extra}: not in the manifest`);
    const status = failures.length === 0 ? 'verified' : 'failed';
    return { verify: { status, checkedAt, failures }, members, manifest };
}

// One member of a whole-server archive, its bytes checked against the manifest, and no other member read: what
// `restore --env` takes on a new machine, before the stage reads and checks them all. Bytes null: no such member.
export async function readServerArchiveMember(
    archivePath: string,
    name: string,
): Promise<{ bytes: Uint8Array | null } | { failure: string }> {
    let members: ArchiveMemberAt[];
    try {
        members = await listArchiveMembers(archivePath);
    } catch (error) {
        return { failure: describeError(error) };
    }
    const manifest = await readClosingManifest(members);
    if (typeof manifest === 'string') return { failure: manifest };
    const named = members.filter((member) => member.name === name);
    const entry = manifest.entries.find((candidate) => candidate.path === name);
    const [member] = named;
    if (named.length > 1) return { failure: `${name}: appears more than once in the archive` };
    if (!member && !entry) return { bytes: null };
    if (!member) return { failure: `${name}: missing from the archive` };
    if (!entry) return { failure: `${name}: not in the manifest` };
    const sizeMismatch = entryMismatch(entry, member.bytes, null);
    if (sizeMismatch) return { failure: sizeMismatch };
    try {
        const bytes = await readArchiveMember(member);
        const mismatch = entryMismatch(entry, bytes.length, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
        return mismatch ? { failure: mismatch } : { bytes };
    } catch (error) {
        return { failure: describeError(error) };
    }
}

// The manifest a whole-server archive closes with, or why it has none.
async function readClosingManifest(members: ArchiveMemberAt[]): Promise<ServerArchiveManifest | string> {
    const last = members.at(-1);
    if (last?.name !== ARCHIVE_MANIFEST_FILE) return `${ARCHIVE_MANIFEST_FILE} is not the last member`;
    let text: string;
    try {
        text = new TextDecoder().decode(await readArchiveMember(last));
    } catch (error) {
        return describeError(error);
    }
    return parseServerArchiveManifest(text) ?? `${ARCHIVE_MANIFEST_FILE} is not a version 1 server archive manifest`;
}
