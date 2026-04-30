import { app } from '../setup';

export const WEBDAV_PASSWORD = 'testpassword123';

export function basicAuth(email: string, password = WEBDAV_PASSWORD): string {
    return `Basic ${btoa(`${email}:${password}`)}`;
}

export function webdavRequest(
    email: string,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${path}`, {
            method,
            headers: {
                Authorization: basicAuth(email),
                ...options.headers,
            },
            body: options.body,
        }),
    );
}
