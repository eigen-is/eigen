import type {User} from 'better-auth/types';

import {getTeamDataPath} from '../config/paths';
import {Home} from './home';
import {parseOwnerId} from "@workspace/lib/types";
import {ApiError, LocalFilesystem} from "../core";
import {Drive} from '../drive';
import {Calendar} from '../calendar/calendar';

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

export type TeamSettings = {
    calendarEnabled?: boolean;
};

export class TeamHome extends Home {
    public teamId: string;
    private settings: TeamSettings = {};

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.teamId = parsed.id;
        this.homeDir = getTeamDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }

    public override async init() {
        await this.loadSettings();
        return super.init();
    }

    override get calendar(): Calendar {
        if (this.settings.calendarEnabled === false) {
            throw new ApiError(404, 'Team calendar is disabled');
        }
        return this._calendar;
    }

    async getSettings(): Promise<TeamSettings> {
        return this.settings;
    }

    async updateSettings(update: Partial<TeamSettings>): Promise<TeamSettings> {
        this.settings = {...this.settings, ...update};
        await this.fs.file('settings.json').write(JSON.stringify(this.settings));
        return this.settings;
    }

    private async loadSettings(): Promise<void> {
        try {
            const file = this.fs.file('settings.json');
            if (await file.exists()) {
                this.settings = await file.json() as TeamSettings;
            }
        } catch {}
    }
}
