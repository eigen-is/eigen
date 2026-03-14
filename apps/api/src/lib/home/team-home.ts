import type {User} from 'better-auth/types';

import {getTeamDataPath} from '../config/paths';
import {Home} from './home';
import {parseOwnerId} from "@workspace/lib/types";
import {ApiError, JsonStore, LocalFilesystem} from "../core";
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
    declare public settings: JsonStore<TeamSettings>;

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.teamId = parsed.id;
        this.homeDir = getTeamDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);

        this.settings = new JsonStore<TeamSettings>(this.fs, 'settings.json', {calendarEnabled: true});
        this._drive = new Drive(this);
        this._calendar = new Calendar(this);
    }

    override get calendar(): Calendar {
        if (this.settings.get().calendarEnabled === false) {
            throw new ApiError(404, 'Team calendar is disabled');
        }
        return this._calendar;
    }
}
