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
        let home = await getHome(user.id);

        let keepalive: Timer | null = null;
        let listener: ((event: SSEvent) => void) | null = null;
        let isClosed = false;

        const stream = new ReadableStream({
            start(controller) {
                listener = (event: SSEvent) => {
                    if (isClosed || controller.desiredSize === null) return;
                    try {
                        controller.enqueue(event);
                    } catch {
                        isClosed = true;
                    }
                };

                home.subscribeSSE(listener);

                // Send initial keepalive immediately to prevent Apache proxy timeout
                try {
                    controller.enqueue({event: 'keepalive'});
                } catch {
                    isClosed = true;
                }

                keepalive = setInterval(async () => {
                    if (isClosed) return;

                    // Keep Home alive — re-acquire if it was destructed externally
                    try {
                        const currentHome = await getHome(user.id);
                        if (currentHome !== home) {
                            console.log(`[SSE] Home recreated for ${user.id}, re-subscribing`);
                            try {
                                home.unsubscribeSSE(listener!);
                            } catch {
                            }
                            currentHome.subscribeSSE(listener!);
                            home = currentHome;
                        }
                    } catch (e) {
                        console.error(`[SSE] Failed to get Home for ${user.id}:`, e);
                    }

                    // Send keepalive to keep HTTP connection alive
                    if (controller.desiredSize === null) {
                        isClosed = true;
                        return;
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
                if (listener) {
                    try {
                        home.unsubscribeSSE(listener);
                    } catch {
                    }
                }
            }
        });

        return sse(stream);
    }, {
        auth: true
    });
