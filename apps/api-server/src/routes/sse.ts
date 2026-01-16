import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";

export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/notifications', async function* ({user}) {
        if (!user) return;

        const home = await getHome(user);
        const queue: string[] = [];
        let resolve: (() => void) | null = null;

        const listener = (event: any) => {
            queue.push(`data: ${JSON.stringify(event)}\n\n`);
            resolve?.();
        };

        home.subscribeSSE(listener);

        try {
            while (true) {
                if (queue.length > 0) {
                    yield queue.shift()!;
                } else {
                    await new Promise<void>(r => { resolve = r; });
                }
            }
        } finally {
            home.unsubscribeSSE(listener);
        }
    }, {
        auth: true
    });
