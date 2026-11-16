// Jobs the server runs on one home's folder: sizing a user's home for the admin Users page, and capturing a
// home for a backup. No other home is the caller, so they are not relay calls, and each assumes the home's
// folder is on this disk. Callers such as the admin user list and the backup jobs use them.

import * as path from 'node:path';
import type { BackupLevel, BackupManifest, BackupProgress } from '@workspace/lib/types/backup';
import type { HomeSizeResponse, UserSettings } from '@workspace/lib/types/settings';
import { snapshotHome } from '../backup/snapshot-home';
import { readCalendarTotalSize } from '../calendar/resource-store';
import { getUserHomePath, homeFolderExists, PATHS } from '../config/paths';
import { readContactsTotalSize } from '../contacts/card-store';
import { LocalFilesystem } from '../core';
import { readMailTotalSize } from '../mail/maildir-store';
import { getMemberships } from '../user';
import { openHome } from './get-home';
import { userHomeSize } from './home';

// Reads the home's files instead of opening the Home, since opening every user's home at once would take seconds.
export async function sizeUserHome(userId: string): Promise<HomeSizeResponse> {
    const homeDir = getUserHomePath(userId);
    const homeFs = homeFolderExists(userId) ? new LocalFilesystem(homeDir) : null;
    const [contacts, mail, calendars] = homeFs
        ? await Promise.all([readContactsTotalSize(homeFs), readMailTotalSize(homeFs), readCalendarTotalSize(homeFs)])
        : [0, 0, 0];
    const settingsFile = Bun.file(path.join(homeDir, PATHS.SETTINGS));
    const settings: UserSettings = (await settingsFile.exists()) ? await settingsFile.json() : {};
    const { teamIds } = await getMemberships(userId);
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
