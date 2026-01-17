import { auth } from "../auth/auth";
import { getServerConfig, saveServerConfig, isSetupRequired as checkSetupRequired, type ServerConfig } from "../config/server-config";

export const isSetupRequired = checkSetupRequired;

export interface SetupInput {
    domain: string;
    storageType: 'local-fullnames' | 'local-id' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
    adminEmail: string;
    adminPassword: string;
    adminName: string;
}

export interface SetupResult {
    success: boolean;
    message?: string;
    error?: string;
    user?: { id: string; email: string; name: string };
}

export async function getSetupStatus() {
    const setupRequired = isSetupRequired();
    
    if (!setupRequired) {
        const config = getServerConfig();
        return { setupRequired: false, domain: config?.domain };
    }
    
    return { setupRequired: true };
}

export async function completeSetup(input: SetupInput): Promise<SetupResult> {
    if (!isSetupRequired()) {
        return { success: false, error: "Setup has already been completed" };
    }

    if (!input.domain) {
        return { success: false, error: "Domain is required" };
    }

    if (!input.storageType) {
        return { success: false, error: "Storage type is required" };
    }

    if (input.storageType === 's3') {
        if (!input.s3Bucket || !input.s3Region || !input.s3AccessKey || !input.s3SecretKey) {
            return { success: false, error: "S3 configuration requires bucket, region, access key, and secret key" };
        }
    }

    if (!input.adminEmail || !input.adminPassword || !input.adminName) {
        return { success: false, error: "Admin email, password, and name are required" };
    }

    if (input.adminPassword.length < 8) {
        return { success: false, error: "Password must be at least 8 characters long" };
    }

    try {
        const user = await auth.api.createUser({
            body: {
                email: input.adminEmail,
                password: input.adminPassword,
                name: input.adminName,
                role: 'admin',
            }
        });

        if (!user) {
            throw new Error('Failed to create admin user');
        }

        const serverConfig: ServerConfig = {
            domain: input.domain,
            storage: {
                type: input.storageType,
                s3: input.storageType === 's3' ? {
                    bucket: input.s3Bucket!,
                    region: input.s3Region!,
                    accessKey: input.s3AccessKey!,
                    secretKey: input.s3SecretKey!,
                    endpoint: input.s3Endpoint
                } : undefined
            },
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString()
        };

        saveServerConfig(serverConfig);

        return {
            success: true,
            message: "Setup completed successfully",
            user: { id: user.user.id, email: user.user.email, name: user.user.name }
        };
    } catch (error) {
        console.error('Setup failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Setup failed'
        };
    }
}
