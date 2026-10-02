import { describe, expect, test } from 'bun:test';
import { isS3ConfigValid, keepsSavedSecret, type S3Config } from '../../types/mount';

const SAVED: S3Config = {
    endpoint: 'https://s3.example.com',
    bucket: 'eigen-backups',
    prefix: '',
    accessKeyId: 'AKIA1',
    secretAccessKey: 'secret',
};

describe('keepsSavedSecret', () => {
    test('keeps it for the same key, endpoint and bucket, whatever the prefix or region', () => {
        expect(keepsSavedSecret({ ...SAVED, secretAccessKey: '', prefix: 'nightly', region: 'eu' }, SAVED)).toBe(true);
    });

    test('never sends it to another key, endpoint or bucket', () => {
        expect(keepsSavedSecret({ ...SAVED, accessKeyId: 'AKIA2' }, SAVED)).toBe(false);
        expect(keepsSavedSecret({ ...SAVED, endpoint: 'https://evil.example.com' }, SAVED)).toBe(false);
        expect(keepsSavedSecret({ ...SAVED, bucket: 'other' }, SAVED)).toBe(false);
    });
});

describe('isS3ConfigValid', () => {
    test('takes a blank secret only where the server keeps one', () => {
        const blank = { ...SAVED, secretAccessKey: '' };
        expect(isS3ConfigValid(blank)).toBe(false);
        expect(isS3ConfigValid(blank, true)).toBe(true);
        expect(isS3ConfigValid({ ...blank, accessKeyId: '' }, true)).toBe(false);
    });
});
