// import { betterAuth } from "better-auth";
import Elysia, { t } from "elysia";
import { getPublicInfo, getAvatar } from "../lib/space/public";
import { waitlist } from "../lib/space/waitlist";


export const spaceRouter = new Elysia({name: "space"})
    // .use(betterAuth)
    .get("/space/avatar/:id/:filename", async ({params}: { params: { id: string, filename: string } }) => await getAvatar(params.id, params.filename), {
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
    .post("/space/waitlist", async ({body}: {body: {email: string, notes: string}}) => {
        return await waitlist(body.email, body.notes);
    }, {
        body: t.Object({
            email: t.String(),
            notes: t.String()
        })
    })