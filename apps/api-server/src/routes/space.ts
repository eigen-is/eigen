import Elysia, {t} from "elysia";
import {getAvatar, getPublicInfo} from "../lib/space/public";
import {waitlist} from "../lib/space/waitlist";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";
import {auth} from "../lib/auth/auth";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)
    .get("/space/avatar/:id/:filename", async ({params, set}) => {
        try {
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'image/webp';
            return await getAvatar(params.id, params.filename);
        } catch (e) {
            set.status = 404;
            return null;
        }
    }, {
        params: t.Object({id: t.String(), filename: t.String()})
    })
    .get("/space/public/:id", async ({params}) => await getPublicInfo(params.id), {
        params: t.Object({id: t.String()})
    })
    .post("/space/waitlist", async ({body}) => await waitlist(body.email, body.notes), {
        body: t.Object({
            email: t.String(),
            notes: t.String()
        })
    })
    .get("/space/zip", async ({user, set}) => {
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
    .post("/space/nu", async ({body}) => {
        return await auth.api.signUpEmail({
            body: {
                email: body.email,
                password: body.password,
                name: body.name
            }
        });
    }, {
        auth: true,
        body: t.Object({
            email: t.String(),
            password: t.String(),
            name: t.String()
        })
    })