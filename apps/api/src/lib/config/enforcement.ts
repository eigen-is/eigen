import {ApiError} from '../core';
import {getHome} from '../home';
import {getMemberships} from '../user';
import {getMaxUploadSize, getMaxBatchUploadSize} from './server-settings';
import {resolveUserQuotas, type ResolvedQuotas} from './quota';
import type {Home} from '../home/home';

async function resolveQuotas(ownerId: string, userId: string, mountId: string): Promise<{home: Home; quotas: ResolvedQuotas}> {
    const home = await getHome(ownerId);
    const mountConfig = home.drive.getMountConfig(mountId);
    const {teamIds} = await getMemberships(userId);
    const quotas = await resolveUserQuotas(mountConfig, teamIds);
    return {home, quotas};
}

export async function enforceFileUpload(ownerId: string, userId: string, mountId: string, fileSize: number): Promise<void> {
    if (fileSize > getMaxUploadSize()) {
        throw new ApiError(413, 'File exceeds max upload size');
    }
    const {home, quotas} = await resolveQuotas(ownerId, userId, mountId);
    const currentSize = await home.drive.size(mountId);
    if (currentSize + fileSize > quotas.mountMax) {
        throw new ApiError(413, 'Storage quota exceeded');
    }
}

export async function enforceBatchUpload(ownerId: string, userId: string, mountId: string, files: {size: number}[]): Promise<void> {
    const maxPerFile = getMaxBatchUploadSize();
    for (const file of files) {
        if (file.size > maxPerFile) {
            throw new ApiError(413, 'File exceeds max batch upload size');
        }
    }
    const {home, quotas} = await resolveQuotas(ownerId, userId, mountId);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const currentSize = await home.drive.size(mountId);
    if (currentSize + totalSize > quotas.mountMax) {
        throw new ApiError(413, 'Storage quota exceeded');
    }
}

export async function enforceAvatarUpload(userId: string, fileSize: number): Promise<void> {
    if (fileSize > getMaxUploadSize()) {
        throw new ApiError(413, 'File exceeds max upload size');
    }
    const {home, quotas} = await resolveQuotas(userId, userId, 'default');
    const mailContactsSize = ((await home.mail?.size()) || 0) + ((await home.contacts?.size()) || 0);
    if (mailContactsSize + fileSize > quotas.mailAndContactsMax) {
        throw new ApiError(413, 'Mail & contacts storage quota exceeded');
    }
}
