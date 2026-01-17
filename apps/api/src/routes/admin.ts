import { Elysia, t } from "elysia";
import { isSetupRequired, createFirstAdminUser } from "../lib/setup/setup";
import { isSystemConfigured, getAllConfig, setAllConfig } from "../lib/config/config";

export const adminRouter = new Elysia({ name: "admin" })
    // Check if system setup is required
    .get("/admin/required", async () => {
        const systemConfigured = await isSystemConfigured();
        const userSetupRequired = await isSetupRequired();
        
        return {
            systemSetupRequired: !systemConfigured,
            userSetupRequired,
            setupRequired: !systemConfigured || userSetupRequired
        };
    })
    
    .post("/admin/setup/system", async ({ body, set }) => {
        const systemConfigured = await isSystemConfigured();
        const userSetupRequired = await isSetupRequired();
        
        if (systemConfigured) {
            set.status = 403;
            return { error: "System has already been configured" };
        }
        
        if (!userSetupRequired) {
            set.status = 403;
            return { error: "Setup is no longer available - admin user already exists" };
        }

        const { storageType, s3Bucket, s3Region, s3AccessKey, s3SecretKey, s3Endpoint } = body;
        
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

        try {
            const config: any = {storageType};
            
            if (storageType === 's3') {
                config.s3Bucket = s3Bucket;
                config.s3Region = s3Region;
                config.s3AccessKey = s3AccessKey;
                config.s3SecretKey = s3SecretKey;
                if (s3Endpoint) config.s3Endpoint = s3Endpoint;
            }
            
            await setAllConfig(config);

            return {
                success: true,
                message: "Storage configured successfully"
            };
        } catch (error) {
            set.status = 500;
            return {
                error: error instanceof Error ? error.message : "Failed to configure storage"
            };
        }
    }, {
        body: t.Object({
            storageType: t.Union([t.Literal('local-fullnames'), t.Literal('local-id'), t.Literal('s3')]),
            s3Bucket: t.Optional(t.String()),
            s3Region: t.Optional(t.String()),
            s3AccessKey: t.Optional(t.String()),
            s3SecretKey: t.Optional(t.String()),
            s3Endpoint: t.Optional(t.String()),
        })
    })
    
    .post("/admin/setup/user", async ({ body, set }) => {
        const systemConfigured = await isSystemConfigured();
        const userSetupRequired = await isSetupRequired();
        
        if (!systemConfigured) {
            set.status = 403;
            return { error: "System must be configured before creating admin user" };
        }
        
        if (!userSetupRequired) {
            set.status = 403;
            return { error: "Admin user has already been created" };
        }

        const { username, password, name } = body;
        
        // Basic validation
        if (!username || !password || !name) {
            set.status = 400;
            return { error: "Username, password, and name are required" };
        }

        if (password.length < 8) {
            set.status = 400;
            return { error: "Password must be at least 8 characters long" };
        }

        // Username is already a full email address (e.g., admin@eigen.is)
        const email = username;

        const result = await createFirstAdminUser(email, password, name);
        
        if (!result.success) {
            set.status = 400;
            return { error: result.error };
        }

        return { 
            success: true, 
            message: "Admin user created successfully",
            user: {
                id: result.user?.id,
                email: result.user?.email,
                name: result.user?.name
            }
        };
    }, {
        body: t.Object({
            username: t.String({ minLength: 1 }),
            password: t.String({ minLength: 8 }),
            name: t.String({ minLength: 1 })
        })
    })
    
    // Get current config (requires auth in future)
    .get("/admin/config", async () => {
        const config = await getAllConfig();
        return config;
    });
