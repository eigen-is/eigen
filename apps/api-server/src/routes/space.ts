// import { betterAuth } from "better-auth";
import Elysia, { t } from "elysia";
import { getPublicInfo, getAvatar } from "../lib/space/public";


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