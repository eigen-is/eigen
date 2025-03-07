import { Elysia } from "elysia";

export const plugin = new Elysia().get("/plugin", "From plugin");
