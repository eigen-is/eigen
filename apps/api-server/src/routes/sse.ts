import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";

export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/notifications', async ({user}) => {
        if (!user) {
            return new Response('Unauthorized', {status: 401});
        }

        const home = await getHome(user);
        
        const encoder = new TextEncoder();
        let keepalive: Timer | null = null;
        let listener: ((event: any) => void) | null = null;
        
        const stream = new ReadableStream({
            start(controller) {
                listener = (event: any) => {
                    const data = `data: ${JSON.stringify(event)}\n\n`;
                    controller.enqueue(encoder.encode(data));
                };

                home.subscribeSSE(listener);

                keepalive = setInterval(() => {
                    controller.enqueue(encoder.encode(': keepalive\n\n'));
                }, 30000);
            },
            cancel() {
                if (keepalive) clearInterval(keepalive);
                if (listener) home.unsubscribeSSE(listener);
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        });
    }, {
        auth: true
    });
