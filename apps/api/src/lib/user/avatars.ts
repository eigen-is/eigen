// The avatar files of users and teams, one picture per owner in a server-wide folder, and a user's name in the
// users database. They are server-wide data, not part of any home. Callers such as a user's own contact card and
// the team routes set them here.

import { teamOwnerId } from '@workspace/lib/types/owner';
import { getAvatarsDir, SERVER_DIR, SERVER_FILES } from '../config/paths';
import { LocalFilesystem } from '../core';
import { updateUser } from './user';

// When homes live in several processes, this becomes a call to the central server.
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(userId, avatarWebP);
    await updateUser(userId, name, avatarWebP ? `${SERVER_DIR}/${SERVER_FILES.avatars}/${userId}.webp` : '');
}

// A team has no row in the auth database to update, so its avatar file is all there is.
export async function pushTeamAvatar(teamId: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(teamOwnerId(teamId), avatarWebP);
}

// The picture lands by a rename, so the avatar route and a backup read it whole.
async function writeAvatar(ownerId: string, avatarWebP: Buffer | null): Promise<void> {
    const avatars = new LocalFilesystem(getAvatarsDir());
    if (avatarWebP) await avatars.writeAtomic(`${ownerId}.webp`, avatarWebP);
    else await avatars.delete(`${ownerId}.webp`);
}
