import Elysia from "elysia";
import {betterAuth} from "./auth";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)