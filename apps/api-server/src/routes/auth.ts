import {type Context, Elysia} from "elysia";
import {auth} from "../lib/auth/auth";

export const betterAuthView = (context: Context) => {
    const BETTER_AUTH_ACCEPT_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    // validate request method
    if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
        return auth.handler(context.request);
    } else {
        return new Response("Method Not Allowed", { status: 405 });
    }
};

// user middleware (compute user and session and pass to routes)
export const betterAuth = new Elysia({name: "better-auth"})
    .mount(auth.handler)
    .macro({
        auth: {
            async resolve({request: {headers}}) {
                const session = await auth.api.getSession({
                    headers,
                });

                if (!session) {
                    throw new Error("Unauthorized");
                }

                return {
                    user: session.user,
                    session: session.session,
                };
            },
        },
    });