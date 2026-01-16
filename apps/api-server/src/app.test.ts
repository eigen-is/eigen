import {describe, expect, test} from "bun:test";
import {app} from "./app";

describe("API Server", () => {
    test("GET / returns welcome message", async () => {
        const response = await app.handle(new Request("http://localhost/"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("eigen|api>");
    });

    test("GET /health returns OK", async () => {
        const response = await app.handle(new Request("http://localhost/health"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("OK");
    });
});
