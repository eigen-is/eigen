import type {User} from 'better-auth/types';

import {createAsyncSingleton} from '../../utils/singleton';
import {getTeamDataPath} from '../config/paths';
import {LocalStorage} from '../storage';
import {Home} from './home';

/**
 * TeamHome is the data container for a team.
 * Extends Home but skips mail/contacts initialization.
 */
export class TeamHome extends Home {
    public teamId: string;

    constructor(teamId: string) {
        const syntheticUser: User = {
            id: `team_${teamId}`,
            name: `team_${teamId}`,
            email: '',
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        super(syntheticUser);
        this.teamId = teamId;
        this.homeDir = getTeamDataPath(teamId);
        this.fs = new LocalStorage(this.homeDir);
    }

    public async init() {
        if (this.initialized) return this;
        if (this.initializationStarted) {
            return new Promise<TeamHome>((resolve) => {
                this.initWaiters.push(resolve as any);
            });
        }
        this.initializationStarted = true;

        await this.initDrive();

        this.initialized = true;
        for (const resolve of this.initWaiters) {
            resolve(this);
        }
        this.initWaiters = [];
        return this;
    }

    public touch() {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = setTimeout(() => {
            cleanupTeamHomeFactory(this.teamId);
            this.destruct();
        }, 1000 * 60 * 5);
        return this;
    }

    protected async destruct() {
        try {
            await this.drive.destruct();
        } catch (error) {
            console.error('Failed to destruct team drive:', error);
        }
    }
}

// Factory
const teamHomeFactories: Map<string, () => Promise<TeamHome>> = new Map();

export function getTeamHome(teamId: string): Promise<TeamHome> {
    if (!teamHomeFactories.has(teamId)) {
        teamHomeFactories.set(teamId, createAsyncSingleton(async () => {
            const home = new TeamHome(teamId);
            await home.init();
            return home.touch();
        }));
    }
    return teamHomeFactories.get(teamId)!();
}

export function cleanupTeamHomeFactory(teamId: string): void {
    teamHomeFactories.delete(teamId);
}

