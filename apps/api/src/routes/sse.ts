import {Elysia, sse} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home";
import type {SSEvent} from "@workspace/lib/types/sse";
import {requireSelf} from "../lib/core/access";

// SSE is personal-only — each user subscribes to their own Home's event stream.
// TODO: to support team SSE, add a separate /sse/team/:teamId/events route with team membership check.
export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/:ownerId/events', async ({params, user}) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id);

        let keepalive: Timer | null = null;
        let listener: ((event: SSEvent) => void) | null = null;
        let isClosed = false;

        const stream = new ReadableStream({
            start(controller) {
                listener = (event: SSEvent) => {
                    if (isClosed) return;
                    try {
                        controller.enqueue(event);
                    } catch {
                        isClosed = true;
                    }
                };

                home.subscribeSSE(listener);

                keepalive = setInterval(() => {
                    if (isClosed) return;
                    try {
                        home.touch();
                    } catch { /* Home may have been destructed */
                    }
                    try {
                        controller.enqueue({event: 'keepalive'});
                    } catch {
                        isClosed = true;
                    }
                }, 30000);
            },
            cancel() {
                isClosed = true;
                if (keepalive) clearInterval(keepalive);
                if (listener) home.unsubscribeSSE(listener);
            }
        });

        return sse(stream);
    }, {
        auth: true
    });
