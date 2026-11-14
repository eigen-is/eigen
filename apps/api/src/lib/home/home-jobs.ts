// Jobs the server runs on one home's folder: sizing a user's home for the admin Users page, and capturing a
// home for a backup. No other home is the caller, so they are not relay calls, and each assumes the home's
// folder is on this disk. Callers such as the admin user list and the backup jobs use them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupLevel, BackupManifest, BackupProgress } from '@workspace/lib/types/backup';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import { snapshotHome } from '../backup/snapshot-home';
import { readCalendarTotalSize } from '../calendar/resource-store';
import { getUserHomePath, PATHS } from '../config/paths';
import { readContactsTotalSize } from '../contacts/card-store';
import { LocalFilesystem } from '../core';
import { readMailTotalSize } from '../mail/maildir-store';
import { getMemberships, getUserById, isGuest } from '../user';
import { openHome } from './get-home';
import { homeSize, userHomeSize } from './home';

// Reads the home's files instead of opening the Home. The admin Users page sizes every user at once,
// and opening each home would take seconds.
export async function sizeUserHome(ownerUserId: string): Promise<HomeSizeResponse> {
    // Sizing reads the folders and quotas of a user home. Other homes, such as a team's, have neither.
    if (parseOwnerId(ownerUserId).type !== 'user') {
        throw new Error(`sizeUserHome expects a user owner id, got ${ownerUserId}`);
    }
    // A guest's home has no folders or quotas of its own, so it answers what the guest home answers.
    if (isGuest(await getUserById(ownerUserId))) return homeSize();
    const homeDir = getUserHomePath(ownerUserId);
    // A user who has never signed in has no home folder yet, and sizing must not create one.
    const homeFs = fs.existsSync(homeDir) ? new LocalFilesystem(homeDir) : null;
    const [contacts, mail, calendars] = homeFs
        ? await Promise.all([readContactsTotalSize(homeFs), readMailTotalSize(homeFs), readCalendarTotalSize(homeFs)])
        : [0, 0, 0];
    const settingsFile = Bun.file(path.join(homeDir, PATHS.SETTINGS));
    const settings: UserSettings = (await settingsFile.exists()) ? await settingsFile.json() : {};
    const { teamIds } = await getMemberships(ownerUserId);
    return userHomeSize(homeDir, settings, contacts + mail + calendars, teamIds);
}

// Opened without counting as a request, so a nightly backup keeps open only the homes somebody uses. It never closes
// the home, which a user may have opened during the capture, and a home that closed meanwhile fails the capture.
export async function snapshotHomeHeld(
    ownerId: string,
    targetDir: string,
    options: { level?: BackupLevel; onProgress?: BackupProgress },
): Promise<BackupManifest> {
    const home = await openHome(ownerId);
    const manifest = await home.withHomeHeld(() => snapshotHome(home, targetDir, options));
    if (home.closing) throw new Error('the home closed during the capture');
    return manifest;
}
