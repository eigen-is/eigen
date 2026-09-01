import type { S3HardenResult } from '@workspace/lib/types/settings';
import { Elysia, t } from 'elysia';
import { ApiError } from '../lib/core/errors';
import { completeSetup, getSetupStatus, isSetupRequired } from '../lib/setup/setup';
import { checkS3Connection, hardenS3Bucket } from '../lib/storage/s3-storage';
import { s3ConfigBody, s3HardenBody, toS3Config } from './shared-schemas';

export const setupRouter = new Elysia({ name: 'setup' })
    .get('/setup/status', () => getSetupStatus())
    .post(
        '/setup/s3check',
        async ({ body }) => {
            if (!isSetupRequired()) throw new ApiError(403, 'Setup already completed');
            return checkS3Connection(toS3Config(body));
        },
        { body: s3ConfigBody },
    )
    .post(
        '/setup/s3harden',
        async ({ body }): Promise<S3HardenResult> => {
            if (!isSetupRequired()) throw new ApiError(403, 'Setup already completed');
            return hardenS3Bucket(toS3Config(body), body.noncurrentDays);
        },
        { body: s3HardenBody },
    )
    .post('/setup/complete', ({ body }) => completeSetup(body), {
        body: t.Object({
            domain: t.String({ minLength: 1 }),
            orgName: t.String({ minLength: 1 }),
            storageType: t.Union([t.Literal('local-fullnames'), t.Literal('local-id'), t.Literal('s3')]),
            s3Bucket: t.Optional(t.String()),
            s3Region: t.Optional(t.String()),
            s3AccessKeyId: t.Optional(t.String()),
            s3SecretAccessKey: t.Optional(t.String()),
            s3Endpoint: t.Optional(t.String()),
            adminEmail: t.String({ minLength: 1 }),
            adminPassword: t.String({ minLength: 8 }),
            adminName: t.String({ minLength: 1 }),
        }),
    });
