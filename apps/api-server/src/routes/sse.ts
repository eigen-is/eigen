import {Elysia, sse} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home";

export const sseRouter = new Elysia({name: "sse"})
    .use(betterAuth)
    .get('/sse/notifications', async function* ({user}) {
        if (!user) return;

        const home = await getHome(user);
        const queue: any[] = [];
        let resolve: (() => void) | null = null;

        const listener = (event: any) => {
            queue.push(event);
            resolve?.();
        };

        home.subscribeSSE(listener);

        try {
            while (true) {
                if (queue.length > 0) {
                    yield sse(queue.shift());
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
