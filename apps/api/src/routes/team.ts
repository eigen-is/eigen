import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import type {TeamHome} from "../lib/home";
import {getHome} from "../lib/home";
import {teamOwnerId} from "@workspace/lib/types";
import {requireTeamAccess, requireTeamAdmin} from "../lib/core/errors";

async function getTeamHome(teamId: string): Promise<TeamHome> {
    return await getHome(teamOwnerId(teamId)) as TeamHome;
}

export const teamRouter = new Elysia({name: "team"})
    .use(betterAuth)

    .get("/team/:teamId/settings", async ({params, user}) => {
        await requireTeamAccess(user.id, params.teamId);
        const teamHome = await getTeamHome(params.teamId);
        return teamHome.settings.get();
    }, {auth: true})

    .put("/team/:teamId/settings", async ({params, body, user}) => {
        await requireTeamAdmin(user.id, params.teamId);
        const teamHome = await getTeamHome(params.teamId);
        return await teamHome.settings.set({
            ...body,
            memberOverrides: body.memberOverrides ? {
                mailAndContactsMaxMB: body.memberOverrides.mailAndContactsMaxMB ?? undefined,
                defaultMountMaxSizeMB: body.memberOverrides.defaultMountMaxSizeMB ?? undefined,
            } : undefined,
        });
    }, {
        body: t.Object({
            calendar: t.Optional(t.Object({enabled: t.Optional(t.Boolean())})),
            memberOverrides: t.Optional(t.Object({
                mailAndContactsMaxMB: t.Optional(t.Nullable(t.Number({minimum: 10}))),
                defaultMountMaxSizeMB: t.Optional(t.Nullable(t.Number({minimum: 10}))),
            })),
        }),
        auth: true,
    })

    .get("/team/:teamId/mounts", async ({params, user}) => {
        await requireTeamAccess(user.id, params.teamId);
        const teamHome = await getTeamHome(params.teamId);
        return teamHome.settings.get().mounts ?? {};
    }, {auth: true})

    .post("/team/:teamId/mount", async ({params, body, user}) => {
        await requireTeamAdmin(user.id, params.teamId);
        const teamHome = await getTeamHome(params.teamId);
        return teamHome.addMount(body);
    }, {
        body: t.Object({
            name: t.String({minLength: 1}),
            storageType: t.Optional(t.Union([
                t.Literal('local'), t.Literal('local-key'), t.Literal('s3'),
            ])),
            maxSizeMB: t.Optional(t.Number({minimum: 10})),
        }),
        auth: true,
    })

    .put("/team/:teamId/mount/:mountId", async ({params, body, user}) => {
        await requireTeamAdmin(user.id, params.teamId);
        const teamHome = await getTeamHome(params.teamId);
        return teamHome.updateMount(params.mountId, body);
    }, {
        body: t.Object({
            enabled: t.Optional(t.Boolean()),
            maxSizeMB: t.Optional(t.Number({minimum: 10})),
            name: t.Optional(t.String({minLength: 1})),
        }),
        auth: true,
    });
