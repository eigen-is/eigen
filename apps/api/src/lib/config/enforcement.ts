import { ApiError } from '../core';
import { getHome } from '../home';
import type { Home } from '../home/home';
import { getMemberships } from '../user';
import { type ResolvedQuotas, resolveUserQuotas } from './quota';
import { getMaxUploadSize } from './server-settings';

async function resolveQuotas(
    ownerId: string,
    userId: string,
    mountId: string,
): Promise<{ home: Home; quotas: ResolvedQuotas }> {
    const home = await getHome(ownerId);
    const mountConfig = home.drive.getMountConfig(mountId);
    const { teamIds } = await getMemberships(userId);
    const quotas = await resolveUserQuotas(mountConfig, teamIds);
    return { home, quotas };
}

export async function getUploadMaxSize(ownerId: string, userId: string, mountId: string): Promise<number> {
    const maxUpload = getMaxUploadSize();
    const { home, quotas } = await resolveQuotas(ownerId, userId, mountId);
    const currentSize = await home.drive.size(mountId);
    const remainingQuota = quotas.mountMax - currentSize;
    if (remainingQuota <= 0) {
        throw new ApiError(413, 'Storage quota exceeded');
    }
    return Math.min(maxUpload, remainingQuota);
}

export async function enforceAvatarUpload(userId: string, fileSize: number): Promise<void> {
    if (fileSize > getMaxUploadSize()) {
        throw new ApiError(413, 'File exceeds max upload size');
    }
    const { home, quotas } = await resolveQuotas(userId, userId, 'default');
    const mailContactsSize = ((await home.mail?.size()) || 0) + ((await home.contacts?.size()) || 0);
    if (mailContactsSize + fileSize > quotas.mailAndContactsMax) {
        throw new ApiError(413, 'Mail & contacts storage quota exceeded');
    }
}
