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
export const publicApi = api.p;
export const driveApi = api.drive;
export const homeApi = api.home;
export const chatApi = api.chat;

export const getPublicAvatarUrl = (emailOrId: string) => `${API_HOST}/p/avatar/${encodeURIComponent(emailOrId)}`;

export const adminApi = api.admin;
export const setupApi = api.setup;

export const getSSEEventsUrl = (ownerId: string) => `${API_HOST}/sse/${ownerId}/events`;
export const getContactsAvatarUploadUrl = (ownerId: string) => `${API_HOST}/contacts/${ownerId}/avatar`;
export const getDriveFileUploadUrl = (ownerId: string, mountId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}`;
export const getDriveFilesUploadUrl = (ownerId: string, mountId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/${mountId}/files/${pathId}`;
export const getDriveDownloadUrl = (ownerId: string, mountId: string, pathId: string) => `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/download`;
export const getDriveEmbedUrl = (ownerId: string, mountId: string, pathId: string, fileName: string) => `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/embed/${fileName}`;
export const getDriveThumbnailUrl = (ownerId: string, mountId: string, fileName: string) => `${API_HOST}/drive/${ownerId}/${mountId}/thumb/${fileName}`;
export const getCollabAccessUrl = (ownerId: string, mountId: string, pathId: string) => `${API_HOST}/collab/${ownerId}/${mountId}/${pathId}/access`;
export const getCollabWebSocketUrl = (ownerId: string, mountId: string, pathId: string) => `${API_HOST.replace('http', 'ws')}/ws/collab/${ownerId}/${mountId}/${pathId}`;

export const getMailMessageDownloadUrl = (messageId: string) => `${API_HOST}/mail/message/download/${messageId}`;
export const getMailAttachmentUrl = (messageId: string, attachmentIndex: number, fileName: string) => `${API_HOST}/mail/message/${messageId}/attachment/${attachmentIndex}/${encodeURIComponent(fileName)}`;
export const getSpaceZipUrl = () => `${API_HOST}/space/zip`;