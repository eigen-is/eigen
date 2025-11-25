import Elysia, { t } from "elysia";
import { getUserByEmailHash, getUsersByEmailHashes } from "../lib/gravatar/gravatar";

/**
 * Get base URL from request
 * Helper to construct full avatar URLs
 */
function getBaseUrl(request: Request): string {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
}

export const gravatarRouter = new Elysia({ name: "public" })
    .get("/public/gravatar/:hash", async ({ params, request, set }: {
        params: { hash: string },
        request: Request,
        set: any
    }) => {
        console.log("Gravatar single lookup called with hash:", params.hash);
        const baseUrl = getBaseUrl(request);
        const result = await getUserByEmailHash(params.hash, baseUrl);

        // Set caching headers (1 hour)
        set.headers['Cache-Control'] = 'public, max-age=3600';
        set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();

        return result;
    }, {
        params: t.Object({
            hash: t.String()
        })
    })
    .post("/public/gravatar/batch", async ({ body, request, set }: {
        body: { hashes: string[] },
        request: Request,
        set: any
    }) => {
        console.log("Gravatar batch lookup called with", body.hashes.length, "hashes");
        const baseUrl = getBaseUrl(request);

        // Limit batch size to prevent abuse
        const MAX_BATCH_SIZE = 100;
        const hashes = body.hashes.slice(0, MAX_BATCH_SIZE);

        const results = await getUsersByEmailHashes(hashes, baseUrl);

        // Set caching headers (1 hour)
        set.headers['Cache-Control'] = 'public, max-age=3600';
        set.headers['Expires'] = new Date(Date.now() + 3600000).toUTCString();

        return { results };
    }, {
        body: t.Object({
            hashes: t.Array(t.String())
        })
    });

console.log("Gravatar router created successfully");

