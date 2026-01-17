import Elysia, { t } from "elysia";
import { getUserByEmailHash, getUsersByEmailHashes } from "../lib/gravatar/gravatar";

function getBaseUrl(request: Request): string {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
}

export const gravatarRouter = new Elysia({ name: "public" })
    .get("/public/gravatar/:hash", async ({ params, request, set }) => {
        const baseUrl = getBaseUrl(request);
        const result = await getUserByEmailHash(params.hash, baseUrl);
        set.headers['Cache-Control'] = 'public, max-age=3600';
        set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();
        return result;
    })
    .post("/public/gravatar/batch", async ({ body, request, set }) => {
        const baseUrl = getBaseUrl(request);
        const hashes = body.hashes.slice(0, 100);
        const results = await getUsersByEmailHashes(hashes, baseUrl);
        set.headers['Cache-Control'] = 'public, max-age=3600';
        set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();
        return { results };
    }, {
        body: t.Object({
            hashes: t.Array(t.String())
        })
    });

