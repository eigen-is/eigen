import Elysia, {t} from "elysia";
import {getAvatar, getPublicInfo} from "../lib/space/public";
import {waitlist} from "../lib/space/waitlist";
import {betterAuth} from "./auth";
import {type User} from "better-auth/types";
import { getHome } from "../lib/home/home";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)
    .get("/space/avatar/:id/:filename", async ({params, set}: {
        params: { id: string, filename: string },
        set: any
    }) => {
        try {
            // Set caching headers for thumbnails (1 day)
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'image/webp';

            return await getAvatar(params.id, params.filename);
        } catch (e) {
            set.status = 404;
            return null;
        }
    }, {
        params: t.Object({
            id: t.String(),
            filename: t.String()
        })
    })
    .get("/space/public/:id", async ({params}: { params: { id: string } }) => await getPublicInfo(params.id), {
        params: t.Object({
            id: t.String()
        })
    })
    .post("/space/waitlist", async ({body}: { body: { email: string, notes: string } }) => {
        return await waitlist(body.email, body.notes);
    }, {
        body: t.Object({
            email: t.String(),
            notes: t.String()
        })
    })
    .get("/space/zip", async ({user, set}: {user: User, set: any}) => {
        try {
            const home = await getHome(user);
            const data = await home.getZip();
            // one caching headers to one hour   
            set.headers['Cache-Control'] = 'public, max-age=3600';
            set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();
            set.headers['Content-Type'] = data.contentType;
            set.headers['Content-Disposition'] = `attachment; filename="${data.fileName}"`;
            return data.data;
        } catch(e) {
            // server error
            set.status = 500;
            return null;
        }
    }, {
        auth: true
    })