import type {User} from 'better-auth/types';
import {randomUUID} from 'crypto';

import {getTeamDataPath} from '../config/paths';
import {Home} from './home';
import {parseOwnerId} from "@workspace/lib/types";
import type {MountSettings, TeamSettings} from "@workspace/lib/types/settings";
import {ApiError, JsonStore, LocalFilesystem} from "../core";
import {Drive} from '../drive';
import {Calendar} from '../calendar/calendar';
import {createMountConfig} from '../mount';
import {getServerSettings, mapStorageType} from '../config/server-settings';

export function getSyntheticTeamUser(ownerId: string): User {
    const parsed = parseOwnerId(ownerId);
    if (!parsed || parsed.type !== 'team') {
        throw new ApiError(400, 'Invalid teamId format');
    }

    return {
        id: ownerId,
        name: ownerId,
        email: '',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

export class TeamHome extends Home {
    public teamId: string;
    declare public settings: JsonStore<TeamSettings>;

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.teamId = parsed.id;
        this.homeDir = getTeamDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.settings = new JsonStore<TeamSettings>(this.fs, 'settings.json', {calendar: {enabled: true}});
        // Teams start with no mounts by default — mounts are added explicitly via "Add Mount" wizard
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }

    override get calendar(): Calendar {
        if (this.settings.get().calendar?.enabled === false) {
            throw new ApiError(404, 'Team calendar is disabled');
        }
        this.touch();
        return this._calendar;
    }

    async addMount(input: {name: string; storageType?: string; maxSizeMB?: number}): Promise<{id: string} & MountSettings> {
        const mountId = randomUUID().slice(0, 8);
        const serverSettings = getServerSettings();
        const mountSettings: MountSettings = {
            storageType: (input.storageType ?? mapStorageType(serverSettings.defaults.mount.storageType)) as MountSettings['storageType'],
            maxSizeMB: input.maxSizeMB ?? serverSettings.quotas.defaultMountMaxSizeMB,
            enabled: true,
            name: input.name,
        };

        const currentMounts = this.settings.get().mounts ?? {};
        await this.settings.set({mounts: {...currentMounts, [mountId]: mountSettings}});

        const config = createMountConfig(mountId, mountSettings);
        await this.drive.addMount(config);

        return {id: mountId, ...mountSettings};
    }

    async updateMount(mountId: string, update: Partial<Pick<MountSettings, 'enabled' | 'maxSizeMB' | 'name'>>): Promise<MountSettings> {
        const existing = this.settings.get().mounts?.[mountId];
        if (!existing) throw new ApiError(404, 'Mount not found');

        const updated = {...existing, ...update};
        await this.settings.set({mounts: { [mountId]: updated}});
        return updated;
    }
}
