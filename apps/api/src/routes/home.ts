import {Elysia} from "elysia";
import {betterAuth} from "./auth.ts";
import {getHome} from "../lib/home";
import {getMemberships} from "../lib/user";
import {requireSelf} from "../lib/core/errors";

// Home routes are personal-only (storage size, data export)
export const homeRouter = new Elysia({name: "home"})
    .use(betterAuth)

    .get("/home/:ownerId/size", async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id);
        const {teamIds} = await getMemberships(user.id);
        return await home.size(teamIds);
    }, {
        auth: true
    })
    .get("/home/:ownerId/zip", async ({params, user, set}) => {
        requireSelf(params.ownerId, user.id);
        try {
            const home = await getHome(user.id);
            const data = await home.getZip();
            set.headers['Cache-Control'] = 'public, max-age=3600';
            set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();
            set.headers['Content-Type'] = data.contentType;
            set.headers['Content-Disposition'] = `attachment; filename="${data.fileName}"`;
            return data.data;
        } catch (e) {
            set.status = 500;
            return null;
        }
    }, {auth: true})