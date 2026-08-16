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
    const home = await getHome(ownerId); // ownerId-routed: called from drive upload routes
    const mountConfig = home.drive.getMountConfig(mountId);
    const { teamIds } = await getMemberships(userId);
    const quotas = await resolveUserQuotas(mountConfig, teamIds);
    return { home, quotas };
}

export async function getMountQuotaState(
    ownerId: string,
    userId: string,
    mountId: string,
): Promise<{ used: number; max: number }> {
    const { home, quotas } = await resolveQuotas(ownerId, userId, mountId);
    const used = await home.drive.size(mountId);
    return { used, max: quotas.mountMax };
}

// addBytes is the bytes about to be written; creditExisting is the size of the
// file being overwritten (subtracted from the projected total). Throws 507 if
// the projection would exceed the mount's quota.
export async function enforceMountQuota(
    ownerId: string,
    userId: string,
    mountId: string,
    addBytes: number,
    creditExisting = 0,
): Promise<void> {
    const { used, max } = await getMountQuotaState(ownerId, userId, mountId);
    if (used + addBytes - creditExisting > max) {
        throw new ApiError(507, 'Insufficient Storage');
    }
}

export async function getUploadMaxSize(ownerId: string, userId: string, mountId: string): Promise<number> {
    const { used, max } = await getMountQuotaState(ownerId, userId, mountId);
    const remainingQuota = max - used;
    if (remainingQuota <= 0) {
        throw new ApiError(507, 'Insufficient Storage');
    }
    return Math.min(getMaxUploadSize(), remainingQuota);
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

// The other half of the storage budget — mail and contacts share one quota. Mirrors getMountQuotaState.
async function getMailAndContactsQuotaState(userId: string): Promise<{ used: number; max: number }> {
    const { home, quotas } = await resolveQuotas(userId, userId, 'default');
    const used = ((await home.mail?.size()) || 0) + ((await home.contacts?.size()) || 0);
    return { used, max: quotas.mailAndContactsMax };
}

export async function getMailUploadMaxSize(userId: string): Promise<number> {
    const maxUpload = Math.min(getMaxUploadSize(), MAX_ATTACHMENT_SIZE);
    const { used, max } = await getMailAndContactsQuotaState(userId);
    const remainingQuota = max - used;
    if (remainingQuota <= 0) {
        throw new ApiError(507, 'Insufficient Storage');
    }
    return Math.min(maxUpload, remainingQuota);
}

export function enforceMaxUploadSize(fileSize: number): void {
    if (fileSize > getMaxUploadSize()) {
        throw new ApiError(413, 'File exceeds max upload size');
    }
}

export async function enforceAvatarUpload(userId: string, fileSize: number): Promise<void> {
    enforceMaxUploadSize(fileSize);
    const { used, max } = await getMailAndContactsQuotaState(userId);
    if (used + fileSize > max) {
        throw new ApiError(507, 'Insufficient Storage');
    }
}

// A contact card about to be written: addBytes is the new card's size, creditBytes the size of the card it
// replaces (subtracted from the projection, so a rewrite that shrinks a card is never refused). Same credit
// convention as enforceMountQuota, for the mail+contacts half of the budget.
export async function enforceContactsIngest(userId: string, addBytes: number, creditBytes = 0): Promise<void> {
    const { used, max } = await getMailAndContactsQuotaState(userId);
    if (used + addBytes - creditBytes > max) {
        throw new ApiError(507, 'Insufficient Storage');
    }
}
