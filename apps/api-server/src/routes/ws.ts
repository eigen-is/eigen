// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home.ts";
import type {ServerWebSocket} from "bun";
import {keepWebSocketAlive} from "../utils/websockets.ts";

export const wsRouter = new Elysia({name: "ws"})
    .use(betterAuth)
    .ws('/ws/notifications', {
        body: t.String(),
        // response: t.String(),
        auth: true,
        async open(ws) {
            // @ts-ignore
            const user = await ws.data.user;
            if (!user) {
                ws.close();
                return;
            }

            ws.ping();

            (await getHome(user)).subscribe(ws as any as ServerWebSocket);
            keepWebSocketAlive(ws as any as ServerWebSocket, async () => {
                (await getHome(user)).unsubscribe(ws as any as ServerWebSocket);
            });
        },
        message: async (ws, message) => {
            if (!message || message === 'ping') {
                ws.send('pong');
            }
        }
    })
;