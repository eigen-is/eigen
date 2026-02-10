import {Elysia} from "elysia";
import {betterAuth} from "./auth.ts";
import {getHome} from "../lib/home";

export const homeRouter = new Elysia({name: "home"})
    .use(betterAuth)

    // Get root folder
    .get("/home/:ownerId/size", async ({user}) => {
        const home = await getHome(user);
        return await home.size();
    }, {
        auth: true
    })
    .get("/home/:ownerId/zip", async ({user, set}) => {
        try {
            const home = await getHome(user);
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