import {app} from "./app";

app.listen(8000);

export type {App as app} from "./app";

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
