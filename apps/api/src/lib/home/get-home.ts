import {createAsyncSingleton} from '../../utils/singleton';
import type {Home} from './home';
import {getUserById} from "../user/user.ts";
import {ApiError} from "../core";
import {parseOwnerId} from "@workspace/lib/types";
import {UserHome} from "./user-home.ts";
import {getSyntheticTeamUser, TeamHome} from "./team-home.ts";
import {getTeamExists} from "../team/team.ts";
import {getSyntheticOrgUser, OrgHome} from "./org-home.ts";
import {getOrgExists} from "../org/org.ts";

const homeFactories: Map<string, () => Promise<Home>> = new Map();

export async function getHome(ownerId: string): Promise<Home> {
    if (!homeFactories.has(ownerId)) {
        homeFactories.set(ownerId, createAsyncSingleton(async () => {
            const parsed = parseOwnerId(ownerId);
            if (!parsed) {
                throw new ApiError(400, 'Invalid ownerId format');
            }
            let home: Home;
            switch (parsed.type) {
                case 'user': {
                    const user = await getUserById(parsed.id);
                    if (!user) {
                        throw new ApiError(404, 'User not found');
                    }
                    home = new UserHome(user, () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
                case 'team': {
                    if (!await getTeamExists(parsed.id)) {
                        throw new ApiError(404, 'Team not found');
                    }
                    home = new TeamHome(getSyntheticTeamUser(ownerId), () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
                case 'org': {
                    if (!await getOrgExists(parsed.id)) {
                        throw new ApiError(404, 'Organization not found');
                    }
                    home = new OrgHome(getSyntheticOrgUser(ownerId), () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
                default:
                    throw new ApiError(400, 'Unsupported ownerId type');
            }
            await home.init();
            return home.touch();
        }));
    }

    return (await homeFactories.get(ownerId)!()).touch();
}

export function cleanupHomeFactory(ownerId: string): void {
    homeFactories.delete(ownerId);
}
