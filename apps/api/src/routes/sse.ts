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

        function enqueue(controller: ReadableStreamDefaultController, data: SSEvent | { event: string }) {
            if (isClosed || controller.desiredSize === null) return;
            try {
                controller.enqueue(data);
            } catch {
                isClosed = true;
            }
        }

        const stream = new ReadableStream({
            start(controller) {
                listener = (event: SSEvent) => enqueue(controller, event);

                home.subscribeSSE(listener);

                keepalive = setInterval(() => {
                    if (isClosed) return;
                    try {
                        home.touch();
                    } catch { /* Home may have been destructed */
                    }
                    enqueue(controller, {event: 'keepalive'});
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
