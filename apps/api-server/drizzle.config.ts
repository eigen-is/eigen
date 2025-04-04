import { defineConfig } from "drizzle-kit";
export default defineConfig({
    dialect: "sqlite",
    schema: "./auth-schema.ts",
    url: "./data/users3.db",
});