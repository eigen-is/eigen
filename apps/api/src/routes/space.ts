import Elysia, {t} from "elysia";
import {getAvatar, getPublicInfo} from "../lib/space/public";
import {waitlist} from "../lib/space/waitlist";
import {betterAuth} from "./auth";
import {auth} from "../lib/auth/auth";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)
    .get("/space/:ownerId/avatar/:filename", async ({params, set}) => {
        try {
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'image/webp';
            return await getAvatar(params.ownerId, params.filename);
        } catch (e) {
            set.status = 404;
            return null;
        }
    })
    .get("/space/:ownerId/public", async ({params}) => await getPublicInfo(params.ownerId))
    .post("/space/waitlist", async ({body}) => await waitlist(body.email, body.notes), {
        body: t.Object({
            email: t.String(),
            notes: t.String()
        })
    })
    .post("/space/nu", async ({body}) => {
        return await auth.api.signUpEmail({
            body: {
                email: body.email,
                password: body.password,
                name: body.name
            }
        });
    }, {
        body: t.Object({
            email: t.String(),
            password: t.String(),
            name: t.String()
        }),
        auth: true
    })