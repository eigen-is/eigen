// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getHome} from "../lib/home/home.ts";
import type {ServerWebSocket} from "bun";

export const wsRouter = new Elysia({name: "ws"})
    .use(betterAuth)
    .ws('/ws/notifications', {
        body: t.String(),
        response: t.String(),
        auth: true,
        async open(ws) {
            // @ts-ignore
            const user = await ws.data.user;
            if (!user) {
                ws.close();
                return;
            }
            (await getHome(user)).subscribe(ws as any as ServerWebSocket);
            // we should keep the connection open
            setInterval(() => {
                if (ws.readyState === 1) {
                    ws.send('ping');
                }
            }, 15000);
        },
        message: async (ws, message) => {
            if (message === 'ping') {
                ws.send('pong');
            }
        }
    })
;