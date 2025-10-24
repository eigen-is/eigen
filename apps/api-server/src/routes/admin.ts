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
    
    // Configure system settings
    .post("/admin/setup/system", async ({ body, set }) => {
        const systemConfigured = await isSystemConfigured();
        if (systemConfigured) {
            set.status = 403;
            return { error: "System has already been configured" };
        }

        const { domain, smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom } = body;
        
        // Basic validation
        if (!domain || !smtpHost || !smtpPort) {
            set.status = 400;
            return { error: "Domain, SMTP host, and SMTP port are required" };
        }

        try {
            await setAllConfig({
                domain,
                smtpHost,
                smtpPort,
                smtpUser: smtpUser || "",
                smtpPassword: smtpPassword || "",
                smtpFrom: smtpFrom || `noreply@${domain}`,
            });

            return {
                success: true,
                message: "System configured successfully"
            };
        } catch (error) {
            set.status = 500;
            return {
                error: error instanceof Error ? error.message : "Failed to configure system"
            };
        }
    }, {
        body: t.Object({
            domain: t.String({ minLength: 1 }),
            smtpHost: t.String({ minLength: 1 }),
            smtpPort: t.Number({ minimum: 1, maximum: 65535 }),
            smtpUser: t.Optional(t.String()),
            smtpPassword: t.Optional(t.String()),
            smtpFrom: t.Optional(t.String()),
        })
    })
    
    // Create first admin user
    .post("/admin/setup/user", async ({ body, set }) => {
        // Check if user setup is still required
        const required = await isSetupRequired();
        if (!required) {
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
