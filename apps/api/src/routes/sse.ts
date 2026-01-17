import {Elysia, sse} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";

export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/events', async ({user}) => {
        if (!user) {
            return new Response('Unauthorized', {status: 401});
        }

        const home = await getHome(user);
        
        let keepalive: Timer | null = null;
        let listener: ((event: any) => void) | null = null;
        let isClosed = false;
        
        const stream = new ReadableStream({
            start(controller) {
                listener = (event: any) => {
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
