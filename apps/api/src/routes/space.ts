import Elysia, {t} from "elysia";
import {betterAuth} from "./auth";
import type {UserHome} from "../lib/home";
import {getHome} from "../lib/home";
import {requireSelf} from "../lib/core/errors";

// Space routes are personal-only (user settings)
export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)

    .get("/space/:ownerId/settings", async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id) as UserHome;
        return home.settings.get();
    }, {auth: true})

    .put("/space/:ownerId/settings", async ({params, body, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id) as UserHome;
        return await home.settings.set(body);
    }, {body: t.Object({theme: t.Optional(t.Union([t.Literal('light'), t.Literal('dark'), t.Literal('system')]))}), auth: true})
