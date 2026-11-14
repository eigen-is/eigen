// The avatar files of users and teams, one picture per owner in a server-wide folder, and a user's name in the
// users database. They are server-wide data, not part of any home. Callers such as a user's own contact card and
// the team routes set them here, and readers such as the public avatar route and a backup find the file by
// avatarFileName.

import { teamOwnerId } from '@workspace/lib/types/owner';
import { getAvatarsDir, SERVER_DIR, SERVER_FILES } from '../config/paths';
import { LocalFilesystem } from '../core';
import { updateUser } from './user';

// When homes live in several processes, this becomes a call to the central server.
export async function writeUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(userId, avatarWebP);
    await updateUser(userId, name, avatarWebP ? `${SERVER_DIR}/${SERVER_FILES.avatars}/${avatarFileName(userId)}` : '');
}

// A team has no row in the auth database to update, so its avatar file is all there is.
export async function writeTeamAvatar(teamId: string, avatarWebP: Buffer | null): Promise<void> {
    await writeAvatar(teamOwnerId(teamId), avatarWebP);
}

export function avatarFileName(ownerId: string): string {
    return `${ownerId}.webp`;
}

// The picture lands by a rename, so the avatar route and a backup read it whole.
async function writeAvatar(ownerId: string, avatarWebP: Buffer | null): Promise<void> {
    const avatars = new LocalFilesystem(getAvatarsDir());
    if (avatarWebP) await avatars.writeAtomic(avatarFileName(ownerId), avatarWebP);
    else await avatars.delete(avatarFileName(ownerId));
}
