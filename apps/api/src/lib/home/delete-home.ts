// Deletes one owner's home for good: its folder, the safety copies a restore left beside it, and the
// bucket objects their s3 drives name. It runs from a better-auth hook before the owner's row goes, such
// as a user's or a team's, so a throw keeps the owner.

import * as fs from 'node:fs';
import { requireHomeSlotFree } from '../backup/jobs';
import { collectHomeObjects, deleteBucketObjects, forgetSafetyCopySize } from '../backup/safety-copy';
import { clearHomeDeleting, evictHome, markHomeDeleting } from './get-home';

// Enough of the keys a refusing bucket kept for an operator to clean up, without one log line per object.
const FAILED_KEYS_LOGGED = 50;

export async function deleteHomeData(ownerId: string, homeDir: string): Promise<void> {
    // A restore, safety-copy delete or capture of this home must finish first: it may hold the only good copy,
    // and a capture reads through the live Home the evict would close.
    requireHomeSlotFree(ownerId);
    // Marked before the evict, so a request from a member's session can't open the home again.
    markHomeDeleting(ownerId);
    try {
        await evictHome(ownerId);
        // Again past the await: nothing awaits between this check and the deletes, so no job can take the slot in between.
        requireHomeSlotFree(ownerId);
    } catch (error) {
        clearHomeDeleting(ownerId);
        throw error;
    }

    // The bucket objects go in the background: a bucket that refuses must not keep the owner.
    const { folders, buckets } = collectHomeObjects(homeDir);
    const objectCount = buckets.reduce((sum, bucket) => sum + bucket.keys.size, 0);
    for (const folder of folders) {
        fs.rmSync(folder, { recursive: true, force: true });
        forgetSafetyCopySize(folder);
    }
    // Nothing records these keys once the folders are gone: a restart mid-way leaves the operator this number.
    if (objectCount > 0) console.log(`[delete-home] deleting ${objectCount} bucket objects of ${ownerId}`);
    deleteBucketObjects(buckets)
        .then((failed) => {
            if (failed.length === 0) return;
            const more = failed.length > FAILED_KEYS_LOGGED ? `, and ${failed.length - FAILED_KEYS_LOGGED} more` : '';
            console.warn(
                `[delete-home] ${failed.length} bucket objects of ${ownerId} could not be deleted: ${failed.slice(0, FAILED_KEYS_LOGGED).join(', ')}${more}`,
            );
        })
        .catch((error) => console.error(`[delete-home] deleting the bucket objects of ${ownerId} failed:`, error));
}
