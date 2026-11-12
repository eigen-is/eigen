// A team home holds what a team shares, such as its drives and its calendar. Nobody signs in as a
// team: members reach it through their own access, and a notification to the team goes to them.
// The team's admins add and change its drives here. A drive's new storage or on/off switch closes the
// whole home, which opens again on the next request.

import type { S3Config } from '@workspace/lib/types/mount';
import { mountStorageIdentity } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { MountSettings, TeamSettings } from '@workspace/lib/types/settings';
import { Calendar } from '../calendar/calendar';
import { getTeamHomePath, PATHS } from '../config/paths';
import { ApiError, JsonStore } from '../core';
import { Drive } from '../drive';
import { createMountConfig, newMountSettings } from '../mount';
import { checkS3Connection } from '../storage';
import { getTeamMembers } from '../team';
import type { User } from '../user';
import { makeSyntheticUser } from '../user';
import { Home } from './home';

export function getSyntheticTeamUser(ownerId: string, teamName?: string): User {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') {
        throw new ApiError(400, 'Invalid teamId format');
    }
    return makeSyntheticUser(ownerId, teamName || ownerId, '');
}

export class TeamHome extends Home {
    public readonly teamId: string;
    public override readonly settings = new JsonStore<TeamSettings>(this.fs, PATHS.SETTINGS, {
        calendar: { enabled: false },
    });

    // No event stream keeps a team home open, only an open document of the team does, so it gets a longer idle.
    protected override idleMs = Number(process.env['TEAM_HOME_IDLE_MS']) || 1000 * 60 * 30;

    public constructor(syntheticUser: User, onClosed?: () => void) {
        const teamId = parseOwnerId(syntheticUser.id).id;
        super(syntheticUser, getTeamHomePath(teamId), onClosed);
        this.teamId = teamId;
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }

    public override get calendar(): Calendar {
        const calendar = super.calendar;
        if (this.settings.get().calendar?.enabled === false) {
            throw new ApiError(404, 'Team calendar is disabled');
        }
        return calendar;
    }

    // A team home has no notification center, so a notification relayed to it goes to these members instead.
    public async membersToNotify(actorEmail?: string | null): Promise<User[]> {
        if (this.settings.get().notifyMembers === false) return [];
        const members = await getTeamMembers(this.teamId);
        return members
            .map((member) => member.user)
            .filter((member) => member.email.toLowerCase() !== actorEmail?.toLowerCase());
    }

    public async addMount(input: {
        name: string;
        storageType?: MountSettings['storageType'];
        maxSizeMB?: number;
        s3Config?: S3Config;
    }): Promise<{ id: string } & MountSettings> {
        const defaults = newMountSettings();
        const mountSettings: MountSettings = {
            ...defaults,
            storageType: input.storageType ?? defaults.storageType,
            maxSizeMB: input.maxSizeMB ?? defaults.maxSizeMB,
            name: input.name,
            s3Config: input.s3Config,
        };

        if (mountSettings.storageType === 's3' && input.s3Config) await refuseDeadBucket(input.s3Config);

        // Added before it is saved, so a closing home that refuses the mount keeps no record of it, and a retry adds
        // one mount, not two.
        const mountId = crypto.randomUUID().slice(0, 8);
        await this.drive.addMount(createMountConfig(mountId, mountSettings));
        await this.settings.set({ mounts: { [mountId]: mountSettings } });
        return { id: mountId, ...mountSettings };
    }

    public async updateMount(
        mountId: string,
        update: Partial<Pick<MountSettings, 'enabled' | 'maxSizeMB' | 'name' | 's3Config'>>,
    ): Promise<MountSettings> {
        const existing = this.settings.get().mounts?.[mountId];
        if (!existing) throw new ApiError(404, 'Mount not found');

        // A mistyped s3Config would replace the working storage with a dead one, and every write would then pile up
        // in the upload queue.
        if (existing.storageType === 's3' && update.s3Config) await refuseDeadBucket(update.s3Config);

        // Only the changed fields are saved. The store merges them into what it holds at that moment,
        // so a change saved by someone else during the check stays.
        const saved = await this.settings.set({ mounts: { [mountId]: update } });
        const updated = saved.mounts?.[mountId];
        if (!updated) throw new ApiError(404, 'Mount not found');
        // A mount binds its storage when it opens, so new storage or an on/off switch closes the home, and the next
        // request opens it on the saved settings.
        if (updated.enabled !== existing.enabled || mountStorageIdentity(updated) !== mountStorageIdentity(existing)) {
            await this.close();
        } else {
            this.drive.updateMount(createMountConfig(mountId, updated));
        }
        return updated;
    }
}

async function refuseDeadBucket(config: S3Config): Promise<void> {
    const s3Result = await checkS3Connection(config);
    if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
}
