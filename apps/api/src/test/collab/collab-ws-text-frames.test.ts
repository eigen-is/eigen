import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { waitFor } from '../fault-storage-helpers';
import { app } from '../setup';

// Elysia JSON-parses a text frame that looks like JSON, and coerces one that reads as a number or a boolean, before a
// route's message handler, unless the bun patch in patches/ is applied. This fails when that patch is missing, such as
// after an Elysia upgrade it no longer matches. A probe route under the app's WebSocket options records what it got.

const received: unknown[] = [];
const server = new Elysia({ websocket: app.config.websocket }).ws('/probe', {
    message(_ws, message) {
        received.push(message);
    },
});
let port: number | undefined;

beforeAll(() => {
    port = server.listen(0).server?.port;
});

afterAll(() => {
    server.stop();
});

test('every text frame reaches the handler as the string it is, a few MB of JSON included', async () => {
    const frames = [`[${'0,'.repeat(2 * 1024 * 1024)}0]`, '{"a":1}', '"quoted"', '/x', '42', 'true', 'null', 'ping'];
    const ws = new WebSocket(`ws://localhost:${port}/probe`);
    await new Promise((resolve) => {
        ws.onopen = resolve;
    });
    for (const frame of frames) ws.send(frame);
    await waitFor(() => received.length === frames.length, 10_000);
    ws.close();
    expect(received.map((message) => typeof message)).toEqual(frames.map(() => 'string'));
    expect(received).toEqual(frames);
});
