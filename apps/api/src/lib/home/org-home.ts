import type {User} from 'better-auth/types';

import {getOrgDataPath} from '../config/paths';
import {LocalStorage} from '../storage';
import {Home} from './home';
import {orgOwnerId} from "@workspace/lib/types";

export class OrgHome extends Home {
    public teamId: string;

    constructor(teamId: string) {
        const syntheticUser: User = {
            id: orgOwnerId(teamId),
            name: orgOwnerId(teamId),
            email: '',
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        super(syntheticUser);
        this.teamId = teamId;
        this.homeDir = getOrgDataPath(teamId);
        this.fs = new LocalStorage(this.homeDir);
    }
}