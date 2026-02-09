import {treaty} from '@elysiajs/eden';
import type {app} from "@apps/api";

export const API_HOST = import.meta.env.VITE_API_HOST as string;

export const api = treaty<app>(API_HOST, {
    fetch: {
        credentials: 'include'
    }
});

export const contactsApi = api.contacts;
export const mailApi = api.mail;
export const spaceApi = api.space;
export const driveApi = api.drive;
export const homeApi = api.home;

export const adminApi = api.admin;
export const setupApi = api.setup;

export const getSSEEventsUrl = (ownerId: string) => `${API_HOST}/sse/${ownerId}/events`;
export const getContactsAvatarUploadUrl = (ownerId: string) => `${API_HOST}/contacts/${ownerId}/avatar`;
export const getDriveFileUploadUrl = (ownerId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/file/${pathId}`;
export const getDriveFilesUploadUrl = (ownerId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/files/${pathId}`;
export const getDriveDownloadUrl = (ownerId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/file/${pathId}/download`;
export const getDriveEmbedUrl = (ownerId: string, pathId: string, fileName: string) => `${API_HOST}/drive/${ownerId}/file/${pathId}/embed/${fileName}`;
export const getDriveThumbnailUrl = (ownerId: string, fileName: string) => `${API_HOST}/drive/${ownerId}/thumb/${fileName}`;