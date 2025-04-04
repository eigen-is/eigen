import Elysia, {t} from "elysia";
import {getAvatar, getPublicInfo} from "../lib/space/public";
import {waitlist} from "../lib/space/waitlist";

export const spaceRouter = new Elysia({name: "space"})
    // .use(betterAuth)
    .get("/space/avatar/:id/:filename", async ({params, set}: {
        params: { id: string, filename: string },
        set: any
    }) => {
        // Set caching headers for thumbnails (5 minutes)
        set.headers['Cache-Control'] = 'public, max-age=300';
        set.headers['Expires'] = new Date(Date.now() + 300000).toUTCString();

        return await getAvatar(params.id, params.filename);
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
.post("/space/nu", async ({body}: { body: { email: string, password: string, name: string } }) => {
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
    })
})