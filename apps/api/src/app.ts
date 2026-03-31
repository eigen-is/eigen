import cors from '@elysiajs/cors';
import { serverTiming } from '@elysiajs/server-timing';
import swagger from '@elysiajs/swagger';
import Elysia from 'elysia';
import { rateLimit } from 'elysia-rate-limit';
import { trustedOrigins } from './lib/auth/auth';
import { caldavRouter } from './lib/caldav/caldav-router';
import { ApiError } from './lib/core/errors';
import { betterAuth } from './routes/auth';
import { calendarRouter } from './routes/calendar';
import { chatRouter } from './routes/chat';
import { collabRouter } from './routes/collab';
import { contactsRouter } from './routes/contacts';
import { driveRouter } from './routes/drive.ts';
import { editorRouter } from './routes/editor';
import { homeRouter } from './routes/home.ts';
import { internalRouter } from './routes/internal';
import { mailRouter } from './routes/mail';
import { notificationRouter } from './routes/notification';
import { publicRouter } from './routes/public';
import { settingsRouter } from './routes/settings';
import { setupRouter } from './routes/setup';
import { spaceRouter } from './routes/space';
import { sseRouter } from './routes/sse';
import { teamRouter } from './routes/team';

const SLOW_REQUEST_MS = 200;

const DAV_CAPABILITY_HEADERS = {
    DAV: '1, 2, 3, calendar-access',
    Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR',
};

export const app = new Elysia()
    .use(serverTiming())
    .use(swagger())
    // Handle CalDAV OPTIONS before CORS intercepts them — CalDAV clients need DAV capability headers
    .onRequest(({ request }) => {
        if (request.method === 'OPTIONS' && new URL(request.url).pathname.startsWith('/dav')) {
            return new Response(null, { status: 204, headers: DAV_CAPABILITY_HEADERS });
        }
    })
    .use(
        cors({
            origin: trustedOrigins,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            credentials: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
        }),
    )
    .use(
        rateLimit({
            duration: 60_000,
            max: 300,
            generator: (request, server) => server?.requestIP(request)?.address ?? 'unknown',
            skip: (request, key) => {
                if (key === 'unknown') return true; // No server (tests / app.handle())
                const path = new URL(request.url).pathname;
                return path === '/health' || path.endsWith('/events');
            },
        }),
    )
    .state('requestStart', 0)
    .onBeforeHandle(({ store }) => {
        store.requestStart = Bun.nanoseconds();
    })
    .onAfterResponse(({ store, request, set }) => {
        const ms = (Bun.nanoseconds() - store.requestStart) / 1_000_000;
        if (ms > SLOW_REQUEST_MS) {
            console.warn(
                `[slow] ${request.method} ${new URL(request.url).pathname} ${ms.toFixed(1)}ms → ${set.status}`,
            );
        }
    })
    .use(betterAuth)
    .use(setupRouter)

    .use(mailRouter)
    .use(contactsRouter)
    .use(calendarRouter)
    .use(teamRouter)
    .use(settingsRouter)
    .use(spaceRouter)
    .use(publicRouter)
    .use(driveRouter)
    .use(homeRouter)
    .use(collabRouter)
    .use(chatRouter)
    .use(editorRouter)
    .use(notificationRouter)
    .use(sseRouter)
    .use(internalRouter)
    .use(caldavRouter)

    .onError(({ error, set, code }) => {
        if (code === 'VALIDATION') return;
        const err = error as Error;
        if (err instanceof ApiError) {
            set.status = err.status;
            return err.message;
        }
        console.error('API Error:', err);
        set.status = 500;
        return 'Internal server error';
    })
    .get('/', () => 'eigen|api>')
    .get('/health', () => 'OK');

export type App = typeof app;
