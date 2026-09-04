import { randomUUID } from 'node:crypto';
import type { S3Config } from '@workspace/lib/types/mount';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { MountSettings, TeamSettings } from '@workspace/lib/types/settings';
import { Calendar } from '../calendar/calendar';
import { getTeamDataPath } from '../config/paths';
import { getServerSettings, mapStorageType } from '../config/server-settings';
import { ApiError, JsonStore, LocalFilesystem } from '../core';
import { Drive } from '../drive';
import { createMountConfig } from '../mount';
import { checkS3Connection } from '../storage/s3-storage';
import { makeSyntheticUser, type User } from '../user';
import { Home } from './home';

export function getSyntheticTeamUser(ownerId: string, teamName?: string): User {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') {
        throw new ApiError(400, 'Invalid teamId format');
    }
    return makeSyntheticUser(ownerId, teamName || ownerId, '');
}

export class TeamHome extends Home {
    public teamId: string;
    public declare settings: JsonStore<TeamSettings>;

    // Team homes have no SSE keep-alive pin (collab sockets touch only at open), so they get a longer idle window.
    protected override idleMs = Number(process.env['TEAM_HOME_IDLE_MS']) || 1000 * 60 * 30;

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.teamId = parsed.id;
        this.homeDir = getTeamDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.settings = new JsonStore<TeamSettings>(this.fs, 'settings.json', { calendar: { enabled: false } });
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }

    override get calendar(): Calendar {
        this.touch();
        if (this.settings.get().calendar?.enabled === false) {
            throw new ApiError(404, 'Team calendar is disabled');
        }
        return this._calendar;
    }

    async addMount(input: {
        name: string;
        storageType?: MountSettings['storageType'];
        maxSizeMB?: number;
        s3Config?: S3Config;
    }): Promise<{ id: string } & MountSettings> {
        const serverSettings = getServerSettings();
        const resolvedType = input.storageType ?? mapStorageType(serverSettings.defaults.mount.storageType);

        if (resolvedType === 's3' && input.s3Config) {
            const s3Result = await checkS3Connection(input.s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
        }

        const mountId = randomUUID().slice(0, 8);
        const mountSettings: MountSettings = {
            storageType: resolvedType,
            maxSizeMB: input.maxSizeMB ?? serverSettings.quotas.defaultMountMaxSizeMB,
            enabled: true,
            name: input.name,
            s3Config: input.s3Config,
        };

        await this.settings.set({ mounts: { [mountId]: mountSettings } });

        const config = createMountConfig(mountId, mountSettings);
        await this.drive.addMount(config);

        return { id: mountId, ...mountSettings };
    }

    async updateMount(
        mountId: string,
        update: Partial<Pick<MountSettings, 'enabled' | 'maxSizeMB' | 'name' | 's3Config'>>,
    ): Promise<MountSettings> {
        const existing = this.settings.get().mounts?.[mountId];
        if (!existing) throw new ApiError(404, 'Mount not found');

        // Same gate as addMount — a typo'd s3Config would tear down the working live backend and
        // pile every write into the upload queue's retry loop against a dead destination.
        if (existing.storageType === 's3' && update.s3Config) {
            const s3Result = await checkS3Connection(update.s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
        }

        const updated = { ...existing, ...update };
        await this.settings.set({ mounts: { [mountId]: updated } });
        // Persisting alone leaves the already-built Drive on a stale config until the Home is evicted;
        // push the change onto the live mount so quota/name/enabled apply immediately.
        await this.drive.updateMount(createMountConfig(mountId, updated), updated.enabled);
        return updated;
    }
}
