// A refused import step rejects with an AppError carrying the server's own message, so the toast reads it rather than
// the raw JSON body the server sent.
import { beforeEach, describe, expect, test } from 'bun:test';
import { AppError } from '../../core/api-error';
import { fetchImportBlob, postImportBytes } from '../../core/transfer';
import { installTransferHarness, served } from '../transfer-harness';

installTransferHarness();

describe('a refused import step', () => {
    beforeEach(() => {
        served.importResponse = { message: 'Not enough storage left' };
        served.status = 507;
    });

    test('posting the bytes rejects with the server message', async () => {
        const failure = postImportBytes('/import', 'text/calendar', new Blob(['x'])).catch((error: unknown) => error);
        expect(await failure).toBeInstanceOf(AppError);
        expect(await failure).toMatchObject({ status: 507, message: 'Not enough storage left' });
    });

    test('fetching the bytes rejects with the server message', async () => {
        const failure = fetchImportBlob('/download').catch((error: unknown) => error);
        expect(await failure).toBeInstanceOf(AppError);
        expect(await failure).toMatchObject({ status: 507, message: 'Not enough storage left' });
    });
});
