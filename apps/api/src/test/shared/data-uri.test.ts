import { describe, expect, test } from 'bun:test';
import { splitDataUri } from '../../lib/shared/data-uri';

describe('splitDataUri', () => {
    test('reads the scheme and the base64 marker in any case, as RFC 2397 allows', () => {
        expect(splitDataUri('DATA:image/PNG;BASE64,iVBO')).toEqual({ mediaType: 'image/png', base64: 'iVBO' });
        expect(splitDataUri('Data:image/png;charset=utf-8;Base64,iVBO')).toEqual({
            mediaType: 'image/png',
            base64: 'iVBO',
        });
    });

    test('is null for a URI that is not base64 or not data:', () => {
        expect(splitDataUri('data:text/plain,hello')).toBeNull();
        expect(splitDataUri('https://example.com/a.png')).toBeNull();
        expect(splitDataUri('data:image/png;base64')).toBeNull();
    });
});
