// Grants read access to the referenced documents a sender opted to share when sending mail, for the send path to
// call. Every ref is fully validated before any ACL is written, so a single unshareable ref aborts the whole grant
// and half-applied grants never need a rollback. Chat exclusion keys off the resolved path type, never the
// client-authored `ref.driveType`.

import { DRIVE_TYPE_CHAT } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive';
import { addRegistryEntry } from '../share/registry';
import type { User } from '../user';

export async function grantAccessForReferences(
    user: User,
    refs: AttachmentReference[],
    grantRefIds: string[],
    emails: string[],
): Promise<void> {
    // Copies of one id would each cost a full ACL write.
    const grantRefs = [...new Set(grantRefIds)].map((id) => {
        const ref = refs.find((r) => r.id === id);
        if (!ref) throw new ApiError(400, `Unknown attachment reference '${id}'`);
        return ref;
    });

    const self = user.email.toLowerCase();
    const grantEmails = emails.map((e) => e.toLowerCase()).filter((e) => e !== self);

    if (grantRefs.length === 0 || grantEmails.length === 0) return;

    const preflighted = [];
    for (const ref of grantRefs) {
        const drive = await getSharedDrive(ref.ownerId, user);
        const path = await drive.getPath(ref.mountId, ref.id);
        if (!path) throw new ApiError(404, `Referenced file "${ref.name}" no longer exists`);
        if (path.type === DRIVE_TYPE_CHAT) {
            throw new ApiError(400, 'Chat references cannot be granted from mail');
        }
        const { canShare, recipients } = await drive.checkAccessForEmails(ref.mountId, ref.id, grantEmails);
        if (!canShare) throw new ApiError(403, `You can no longer share "${ref.name}"`);
        preflighted.push({ drive, ref, path, recipients });
    }

    for (const { drive, ref, path, recipients } of preflighted) {
        // Preserve an existing write bit: mergeACLDelta replaces the entry on upsert, so a plain
        // write:false would silently revoke write from a write-only entry on the path itself.
        const needingAcl = recipients
            .filter((r) => !r.hasReadAccess)
            .map((r) => ({
                id: r.email,
                read: true,
                write: path.acl?.find((a) => a.id === r.email)?.write ?? false,
            }));
        if (needingAcl.length > 0) {
            await drive.updateACLDelta(ref.mountId, ref.id, { add: needingAcl }, undefined, undefined, user, {
                suppressShareEmail: 'all',
            });
        }
        // Recipients who can already read (say via a public ancestor) get no ACL clutter, only a registry entry so a
        // closed-signup guest can be admitted. It is sourced from the path owner, never the sender.
        for (const r of recipients) {
            if (r.hasReadAccess && r.needsGuestAdmission) {
                await addRegistryEntry(path.ownerId, r.email);
            }
        }
    }
}
