import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import { isSafePathSegment } from '../../lib/core/path-utils';
import { createUniqueMessageId } from '../../lib/mail/mailutils';

const hostname = spyOn(os, 'hostname');
afterAll(() => hostname.mockRestore());

describe('createUniqueMessageId', () => {
    test('an id the server mints is a safe path segment, whatever the host is called', () => {
        hostname.mockReturnValue('mail/host:143');
        const id = createUniqueMessageId();
        expect(isSafePathSegment(id)).toBe(true);
        expect(id).not.toContain('/');
        expect(id).not.toContain(':');
    });
});
