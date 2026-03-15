import Elysia, {t} from "elysia";
import {betterAuth} from "./auth";
import type {UserHome} from "../lib/home";
import {getHome} from "../lib/home";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)

    .get("/space/settings", async ({user}) => {
        const home = await getHome(user.id) as UserHome;
        return home.settings.get();
    }, {auth: true})

    .put("/space/settings", async ({body, user}) => {
        const home = await getHome(user.id) as UserHome;
        return await home.settings.set(body);
    }, {body: t.Object({darkMode: t.Optional(t.Union([t.Literal('day'), t.Literal('night'), t.Literal('system')]))}), auth: true})
