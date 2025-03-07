import { Elysia } from "elysia";
import { plugin } from "@backend/module";
import swagger from "@elysiajs/swagger";

const app = new Elysia()
.use(swagger())
.use(plugin)
.listen(3000);

export type app = typeof app;

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
