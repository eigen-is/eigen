import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";
import {plugin} from "./module";
import cors from "@elysiajs/cors";
import {auth} from "../utils/auth/auth";

const app = new Elysia()
    .use(swagger())
    .get("/test", "From test")
    .use(plugin)
    .use(cors({
        origin: "http://localhost:3001",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .mount(auth.handler)
    .listen(8000);

export type app = typeof app;

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
