import type { S3CheckResult, S3HardenResult, SetupResult, SetupStatus } from '@workspace/lib/types/settings';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { completeSetup, getSetupStatus } from '../lib/setup/setup';
import { requireSetupToken } from '../lib/setup/setup-token';
import { checkS3Connection, hardenS3Bucket } from '../lib/storage/s3-storage';
import { s3ConfigBody, s3HardenBody, toS3Config } from './shared-schemas';

// setupToken is optional in the schemas, so a missing one gets requireSetupToken's answer, not a validation error.
export const setupRouter = new Elysia({ name: 'setup' })
    .get('/setup/status', (): SetupStatus => getSetupStatus())
    .post(
        '/setup/s3check',
        async ({ body }): Promise<S3CheckResult> => {
            requireSetupToken(body.setupToken);
            return checkS3Connection(toS3Config(body));
        },
        { body: t.Object({ ...s3ConfigBody.properties, setupToken: t.Optional(t.String()) }) },
    )
    .post(
        '/setup/s3harden',
        async ({ body }): Promise<S3HardenResult> => {
            requireSetupToken(body.setupToken);
            return hardenS3Bucket(toS3Config(body), body.noncurrentDays);
        },
        { body: t.Object({ ...s3HardenBody.properties, setupToken: t.Optional(t.String()) }) },
    )
    .post(
        '/setup/complete',
        ({ body: { setupToken, ...input } }): Promise<SetupResult> => {
            requireSetupToken(setupToken);
            return completeSetup(input);
        },
        {
            body: t.Object({
                setupToken: t.Optional(t.String()),
                orgName: t.String({ minLength: 1 }),
                storageType: t.Union([t.Literal('local-fullnames'), t.Literal('local-id'), t.Literal('s3')]),
                s3Bucket: t.Optional(t.String()),
                s3Region: t.Optional(t.String()),
                s3AccessKeyId: t.Optional(t.String()),
                s3SecretAccessKey: t.Optional(t.String()),
                s3Endpoint: t.Optional(t.String()),
                adminUsername: t.String({ minLength: 1 }),
                adminPassword: t.String({ minLength: MIN_PASSWORD_LENGTH }),
                adminName: t.String({ minLength: 1 }),
            }),
        },
    );
