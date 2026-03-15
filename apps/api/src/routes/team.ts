import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import type {TeamHome} from "../lib/home";
import {getHome} from "../lib/home";
import {getMemberships, getOrgRole} from "../lib/user";
import {teamOwnerId} from "@workspace/lib/types";
import {ApiError} from "../lib/core";

async function requireTeamAdmin(userId: string, teamId: string) {
    const role = await getOrgRole(userId);
    if (role === 'admin' || role === 'owner') return;
    const memberships = await getMemberships(userId);
    if (!memberships.teamIds.includes(teamId)) throw new ApiError(403, 'Not a member of this team');
    throw new ApiError(403, 'Admin or owner role required');
}

export const teamRouter = new Elysia({name: "team"})
    .use(betterAuth)

    .get("/team/:teamId/settings", async ({params, user}) => {
        const memberships = await getMemberships(user.id);
        if (!memberships.teamIds.includes(params.teamId)) throw new ApiError(403, 'Not a member of this team');
        const teamHome = await getHome(teamOwnerId(params.teamId)) as TeamHome;
        return teamHome.settings.get();
    }, {auth: true})

    .put("/team/:teamId/settings", async ({params, body, user}) => {
        await requireTeamAdmin(user.id, params.teamId);
        const teamHome = await getHome(teamOwnerId(params.teamId)) as TeamHome;
        return await teamHome.settings.set(body);
    }, {body: t.Object({calendar: t.Optional(t.Object({enabled: t.Optional(t.Boolean())}))}), auth: true});
