import { adminApi } from '@workspace/lib/api.ts';

export async function checkSetupRequired() {
    const response = await adminApi.required.get();
    return response.data;
}

export async function configureSystem(data: {
    storageType: 'local-fullnames' | 'local-id' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
}) {
    const response = await adminApi.setup.system.post(data as any);
    return response.data;
}

export async function createAdminUser(data: {
    username: string;
    password: string;
    name: string;
}) {
    const response = await adminApi.setup.user.post(data as any);
    return response.data;
}
