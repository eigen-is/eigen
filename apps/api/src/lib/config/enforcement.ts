import { ApiError } from '../core';
import { getHome } from '../home';
import type { Home } from '../home/home';
import { getMemberships } from '../user';
import { type ResolvedQuotas, resolveHomeDataMax, resolveUserQuotas } from './quota';
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

// creditExisting is the size of the file being overwritten, so an in-place rewrite is charged only its growth.
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

// Resolves no mount, so a team Home (which has none) meters its calendar here too; every part answers from an in-memory byte counter, so a device sync costs no query per write.
async function getHomeDataQuotaState(ownerId: string): Promise<{ used: number; max: number }> {
    const home = await getHome(ownerId); // ownerId-routed: this is the Home whose bytes are being charged
    const { teamIds } = await getMemberships(ownerId);
    return { used: await home.dataSize(), max: await resolveHomeDataMax(teamIds) };
}

export async function getMailUploadMaxSize(userId: string): Promise<number> {
    const maxUpload = Math.min(getMaxUploadSize(), MAX_ATTACHMENT_SIZE);
    const { used, max } = await getHomeDataQuotaState(userId);
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
    const { used, max } = await getHomeDataQuotaState(userId);
    if (used + fileSize > max) {
        throw new ApiError(507, 'Insufficient Storage');
    }
}

// How a user at a full budget still edits and cleans up: a rewrite growing by at most the grace passes, and every such edit together overshoots by at most the headroom.
const HOME_DATA_EDIT_GRACE_BYTES = 1024;
const HOME_DATA_EDIT_HEADROOM_BYTES = 1024 * 1024;

// Same credit convention as enforceMountQuota: creditBytes is what the write replaces, 0 for a create.
export async function enforceHomeDataQuota(ownerId: string, addBytes: number, creditBytes = 0): Promise<void> {
    if (creditBytes > 0 && addBytes <= creditBytes) return;
    const { used, max } = await getHomeDataQuotaState(ownerId);
    const withinGrace = creditBytes > 0 && addBytes - creditBytes <= HOME_DATA_EDIT_GRACE_BYTES;
    const ceiling = withinGrace ? max + HOME_DATA_EDIT_HEADROOM_BYTES : max;
    if (used + addBytes - creditBytes > ceiling) {
        throw new ApiError(507, 'Insufficient Storage');
    }
}
