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

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.teamId = parsed.id;
        this.homeDir = getTeamDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.drive = new Drive(this);
        this.calendar = new Calendar(this);
    }

    async getSettings(): Promise<TeamSettings> {
        try {
            const file = this.fs.file('settings.json');
            if (await file.exists()) return await file.json() as TeamSettings;
        } catch {}
        return {};
    }

    async updateSettings(update: Partial<TeamSettings>): Promise<TeamSettings> {
        const settings = {...await this.getSettings(), ...update};
        await this.fs.file('settings.json').write(JSON.stringify(settings));
        return settings;
    }

    async getCalendarIfEnabled(): Promise<Calendar | null> {
        const settings = await this.getSettings();
        if (settings.calendarEnabled === false) return null;
        return this.calendar;
    }
}
