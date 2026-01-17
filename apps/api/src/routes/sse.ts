import {Elysia, sse} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";

export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/notifications', async ({user}) => {
        if (!user) {
            return new Response('Unauthorized', {status: 401});
        }

        const home = await getHome(user);
        
        let keepalive: Timer | null = null;
        let listener: ((event: any) => void) | null = null;
        
        const stream = new ReadableStream({
            start(controller) {
                listener = (event: any) => {
                    controller.enqueue(event);
                };

                home.subscribeSSE(listener);

                keepalive = setInterval(() => {
                    controller.enqueue({event: 'keepalive'});
                }, 30000);
            },
            cancel() {
                if (keepalive) clearInterval(keepalive);
                if (listener) home.unsubscribeSSE(listener);
            }
        });

        return sse(stream);
    }, {
        auth: true
    });
