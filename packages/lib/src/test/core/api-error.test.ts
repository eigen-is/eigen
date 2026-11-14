// Every error toast is one of these strings. The shapes below are the ones Eden hands us: an ApiError's
// plain text, Elysia's validation body (which drops everything but `type`/`on`/`found` in production),
// the untyped routes' empty bodies and a proxy's HTML page. Only a body with no message names its status.
import { describe, expect, test } from 'bun:test';
import { AppError, getErrorMessage, isRefusal } from '../../core/api-error';

describe('AppError messages', () => {
    test('reads the message a body carries', () => {
        const error = new AppError({ error: { status: 507, value: { message: 'Insufficient Storage' } }, status: 507 });

        expect(getErrorMessage(error)).toBe('Insufficient Storage');
    });

    test('reads a plain string body — what every ApiError returns', () => {
        const error = new AppError({ error: { status: 409, value: 'A file with that name exists' }, status: 409 });

        expect(getErrorMessage(error)).toBe('A file with that name exists');
    });

    test('falls back to the response status when the error carries none', () => {
        const error = new AppError({ error: { status: undefined, value: 'Boom' }, status: 500 });

        expect(error.status).toBe(500);
        expect(getErrorMessage(error)).toBe('Boom');
    });

    test("production's message-less validation body reads as a plain rejection", () => {
        const error = new AppError({
            error: { status: 422, value: { type: 'validation', on: 'body', found: { name: 3 } } },
            status: 422,
        });

        expect(getErrorMessage(error)).toBe('Invalid request (422)');
    });

    test("development's validation body reads its message", () => {
        const error = new AppError({
            error: {
                status: 422,
                value: {
                    type: 'validation',
                    on: 'body',
                    property: '/name',
                    message: 'Expected string',
                    summary: "Expected property 'name' to be string but found: 3",
                    found: { name: 3 },
                },
            },
            status: 422,
        });

        expect(getErrorMessage(error)).toBe('Expected string');
    });

    test('a validation body with only a summary reads the summary', () => {
        const error = new AppError({
            error: {
                status: 422,
                value: { type: 'validation', on: 'query', summary: "Expected 'limit' to be number" },
            },
            status: 422,
        });

        expect(getErrorMessage(error)).toBe("Expected 'limit' to be number");
    });

    test('a validation body with only an errors array reads the first error', () => {
        const error = new AppError({
            error: {
                status: 422,
                value: {
                    type: 'validation',
                    on: 'query',
                    errors: [{ path: '/limit', message: 'Expected number', summary: "Expected 'limit' to be number" }],
                },
            },
            status: 422,
        });

        expect(getErrorMessage(error)).toBe("Expected 'limit' to be number");
    });

    test("the server's own message shows without its status", () => {
        const error = new AppError({
            error: { status: 400, value: 'Folders can be nested at most 256 levels deep' },
            status: 400,
        });

        expect(getErrorMessage(error)).toBe('Folders can be nested at most 256 levels deep');
        expect(error.message).toBe('Folders can be nested at most 256 levels deep');
    });

    test('a message-less error still shows its status', () => {
        const error = new AppError({ error: { status: 403, value: '  ' }, status: 403 });

        expect(getErrorMessage(error)).toBe('No access (403)');
        expect(error.message).toBe('No access (403)');
    });

    test("a proxy's HTML error page reads as the status, not as markup", () => {
        const page = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>nginx</body>\r\n</html>';
        const error = new AppError({ error: { status: 502, value: page }, status: 502 });

        expect(getErrorMessage(error)).toBe('Request failed (502)');
    });

    test('an empty body falls back to the status', () => {
        const error = new AppError({ error: { status: 404, value: {} }, status: 404 });

        expect(getErrorMessage(error)).toBe('Not found (404)');
    });

    test('an array body falls back to the status instead of stringifying itself', () => {
        const error = new AppError({ error: { status: 500, value: [{ message: 'nope' }] }, status: 500 });

        expect(getErrorMessage(error)).toBe('Server error (500)');
    });

    test('no error payload at all falls back to the status', () => {
        const error = new AppError({ error: null, status: 500 });

        expect(getErrorMessage(error)).toBe('Server error (500)');
    });

    test('an unmapped status falls back to a generic message', () => {
        const error = new AppError({ error: null, status: 418 });

        expect(getErrorMessage(error)).toBe('Request failed (418)');
    });
});

// A refusal is the server's settled no, such as deleting the organization's default team: asking again gets the same
// answer. A conflict, a busy server or a lost connection may go through on another try.
test('a refusal is a 400, 403, 404, 422 or 423, and nothing a retry could change', () => {
    const withStatus = (status: number) => new AppError({ error: { status, value: 'No' }, status });
    expect([400, 403, 404, 422, 423].filter((status) => !isRefusal(withStatus(status)))).toEqual([]);
    expect([409, 429, 500, 503].map((status) => isRefusal(withStatus(status)))).toEqual([false, false, false, false]);
    expect(isRefusal(new Error('Failed to fetch'))).toBe(false);
});
