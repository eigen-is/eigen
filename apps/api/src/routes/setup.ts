import { Elysia, t } from "elysia";
import { getServerConfig, saveServerConfig, isSetupRequired, type ServerConfig } from "../lib/config/server-config";
import { auth } from "../lib/auth/auth";

export const setupRouter = new Elysia({ name: "setup" })
    .get("/setup/status", async () => {
        const setupRequired = isSetupRequired();
        
        if (!setupRequired) {
            const config = getServerConfig();
            return {
                setupRequired: false,
                domain: config?.domain
            };
        }
        
        return {
            setupRequired: true
        };
    })
    
    .post("/setup/complete", async ({ body, set }) => {
        if (!isSetupRequired()) {
            set.status = 403;
            return { error: "Setup has already been completed" };
        }

        const { domain, storageType, s3Bucket, s3Region, s3AccessKey, s3SecretKey, s3Endpoint, adminEmail, adminPassword, adminName } = body;

        if (!domain) {
            set.status = 400;
            return { error: "Domain is required" };
        }

        if (!storageType) {
            set.status = 400;
            return { error: "Storage type is required" };
        }

        if (storageType === 's3') {
            if (!s3Bucket || !s3Region || !s3AccessKey || !s3SecretKey) {
                set.status = 400;
                return { error: "S3 configuration requires bucket, region, access key, and secret key" };
            }
        }

        if (!adminEmail || !adminPassword || !adminName) {
            set.status = 400;
            return { error: "Admin email, password, and name are required" };
        }

        if (adminPassword.length < 8) {
            set.status = 400;
            return { error: "Password must be at least 8 characters long" };
        }

        try {
            const serverConfig: ServerConfig = {
                domain,
                storage: {
                    type: storageType,
                    s3: storageType === 's3' ? {
                        bucket: s3Bucket!,
                        region: s3Region!,
                        accessKey: s3AccessKey!,
                        secretKey: s3SecretKey!,
                        endpoint: s3Endpoint
                    } : undefined
                },
                setupCompleted: true,
                setupCompletedAt: new Date().toISOString()
            };

            saveServerConfig(serverConfig);

            const result = await auth.api.createUser({
                body: {
                    email: adminEmail,
                    password: adminPassword,
                    name: adminName,
                    role: 'admin'
                }
            });

            if (!result.user) {
                throw new Error('Failed to create admin user');
            }

            return {
                success: true,
                message: "Setup completed successfully",
                user: {
                    id: result.user.id,
                    email: result.user.email,
                    name: result.user.name
                }
            };
        } catch (error) {
            set.status = 500;
            return {
                error: error instanceof Error ? error.message : "Setup failed"
            };
        }
    }, {
        body: t.Object({
            domain: t.String({ minLength: 1 }),
            storageType: t.Union([t.Literal('local-fullnames'), t.Literal('local-id'), t.Literal('s3')]),
            s3Bucket: t.Optional(t.String()),
            s3Region: t.Optional(t.String()),
            s3AccessKey: t.Optional(t.String()),
            s3SecretKey: t.Optional(t.String()),
            s3Endpoint: t.Optional(t.String()),
            adminEmail: t.String({ minLength: 1 }),
            adminPassword: t.String({ minLength: 8 }),
            adminName: t.String({ minLength: 1 })
        })
    });
