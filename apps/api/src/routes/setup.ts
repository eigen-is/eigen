import { Elysia, t } from 'elysia';
import { completeSetup, getSetupStatus } from '../lib/setup/setup';

export const setupRouter = new Elysia({ name: 'setup' })
    .get('/setup/status', () => getSetupStatus())
    .post(
        '/setup/complete',
        async ({ body, set }) => {
            const result = await completeSetup(body);
            if (!result.success) {
                set.status = 400;
            }
            return result;
        },
        {
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
        },
    );
