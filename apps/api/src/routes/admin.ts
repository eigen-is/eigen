import {Elysia} from "elysia";

export const adminRouter = new Elysia({name: "admin"})
    .get("/admin/status", () => {
        return {status: "placeholder", message: "Admin API will be implemented here"};
    });
