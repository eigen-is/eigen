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

// The mail half of the shared quota is an O(N) recursive maildir walk (MaildirStore.size → dirSize). A CardDAV
// device sync meters every card it PUTs, so uncached that is one walk per card. Memoize the mail size per user
// for a short window: a sync burst does at most one walk. 15s comfortably covers an initial-sync burst (cards
// arrive milliseconds apart) while keeping the staleness bound negligible for a soft quota — and the contacts
// half stays live (Contacts.size answers from in-memory byte counters), so contact growth is always exact.
// Only mail delivered inside the window can read stale, which the per-upload and whole-card ceilings still
// bound; REST (avatar upload) and DAV share the one cache, which is safe because both credit the live contacts
// half and only over-permit recently-delivered mail by at most the window.
const MAIL_SIZE_TTL_MS = 15_000;
const mailSizeCache = new Map<string, { value: number; expiresAt: number }>();

async function cachedMailSize(userId: string, home: Home): Promise<number> {
    const now = Date.now();
    const cached = mailSizeCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = (await home.mail?.size()) || 0;
    mailSizeCache.set(userId, { value, expiresAt: now + MAIL_SIZE_TTL_MS });
    return value;
}

// The other half of the storage budget — mail and contacts share one quota. Mirrors getMountQuotaState.
async function getMailAndContactsQuotaState(userId: string): Promise<{ used: number; max: number }> {
    const { home, quotas } = await resolveQuotas(userId, userId, 'default');
    const used = (await cachedMailSize(userId, home)) + ((await home.contacts?.size()) || 0);
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
