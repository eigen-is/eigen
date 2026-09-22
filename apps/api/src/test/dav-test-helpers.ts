import { app } from './setup';

// Every DAV suite authenticates as a seeded test user over HTTP Basic, with the password the setup wizard gave them.
export const DAV_PASSWORD = 'testpassword123';

export const basicAuth = (email: string, password = DAV_PASSWORD): string => `Basic ${btoa(`${email}:${password}`)}`;

// One authenticated DAV request through the real app — the shape every suite's own put/get/report wrapper sits on.
export function davRequest(
    method: string,
    path: string,
    opts: { email: string; headers?: Record<string, string>; body?: BodyInit },
): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${path}`, {
            method,
            headers: { Authorization: basicAuth(opts.email), ...opts.headers },
            body: opts.body,
        }),
    );
}
