import {Elysia} from "elysia";
import {getAllConfig, getPublicConfig} from "../lib/config/config";

export const configRouter = new Elysia({name: "config"})
    .get("/api/config/public", async () => {
        // Load fresh config and return public subset
        await getAllConfig();
        return getPublicConfig();
    });
