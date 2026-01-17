import {Elysia} from "elysia";
import {betterAuth} from "./auth.ts";
import {getHome} from "../lib/home/home.ts";

export const homeRouter = new Elysia({name: "home"})
    .use(betterAuth)

    // Get root folder
    .get("/home/size", async ({user}) => {
        const home = await getHome(user);
        return await home.size();
    }, {
        auth: true
    })