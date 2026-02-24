import Elysia, {t} from "elysia";
import {betterAuth} from "./auth";
import {auth} from "../lib/auth/auth";

export const spaceRouter = new Elysia({name: "space"})
    .use(betterAuth)
    .post("/space/nu", async ({body}) => {
        return await auth.api.signUpEmail({
            body: {
                email: body.email,
                password: body.password,
                name: body.name
            }
        });
    }, {
        body: t.Object({
            email: t.String(),
            password: t.String(),
            name: t.String()
        }),
        auth: true
    })