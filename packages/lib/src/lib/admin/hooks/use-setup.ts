import { adminApi } from '@workspace/lib/api.ts';

export async function checkSetupRequired() {
    const response = await adminApi.required.get();
    return response.data;
}

export async function configureSystem(data: {
    domain: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser?: string;
    smtpPassword?: string;
    smtpFrom?: string;
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
