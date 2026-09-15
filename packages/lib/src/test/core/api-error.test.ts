// Every error toast is one of these strings. The shapes below are the ones Eden hands us: an ApiError's
// plain text, Elysia's validation body (which drops everything but `type`/`on`/`found` in production),
// and the untyped routes' empty bodies.
import { describe, expect, test } from 'bun:test';
import { AppError, getErrorMessage } from '../../core/api-error';

describe('AppError messages', () => {
    test('reads the message a body carries', () => {
        const error = new AppError({ error: { status: 507, value: { message: 'Insufficient Storage' } }, status: 507 });

        expect(getErrorMessage(error)).toBe('Insufficient Storage (507)');
    });

    test('reads a plain string body — what every ApiError returns', () => {
        const error = new AppError({ error: { status: 409, value: 'A file with that name exists' }, status: 409 });

        expect(getErrorMessage(error)).toBe('A file with that name exists (409)');
    });

    test('falls back to the response status when the error carries none', () => {
        const error = new AppError({ error: { status: undefined, value: 'Boom' }, status: 500 });

        expect(getErrorMessage(error)).toBe('Boom (500)');
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

        expect(getErrorMessage(error)).toBe('Expected string (422)');
    });

    test('a validation body with only a summary reads the summary', () => {
        const error = new AppError({
            error: {
                status: 422,
                value: { type: 'validation', on: 'query', summary: "Expected 'limit' to be number" },
            },
            status: 422,
        });

        expect(getErrorMessage(error)).toBe("Expected 'limit' to be number (422)");
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

        expect(getErrorMessage(error)).toBe("Expected 'limit' to be number (422)");
    });

    test('an empty body falls back to the status', () => {
        const error = new AppError({ error: { status: 404, value: {} }, status: 404 });

        expect(getErrorMessage(error)).toBe('Not found (404)');
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
