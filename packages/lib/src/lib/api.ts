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
export const publicApi = api.p;
export const driveApi = api.drive;
export const homeApi = api.home;
export const chatApi = api.chat;
export const setupApi = api.setup;

export const SPACE_APP_URL = import.meta.env.VITE_APP_SPACE_URL as string;
export const MAIL_APP_URL = import.meta.env.VITE_APP_MAIL_URL as string;
export const CONTACTS_APP_URL = import.meta.env.VITE_APP_CONTACTS_URL as string;
export const DRIVE_APP_URL = import.meta.env.VITE_APP_DRIVE_URL as string;
export const DOCS_APP_URL = import.meta.env.VITE_APP_DOCS_URL as string;
export const STICKIES_APP_URL = import.meta.env.VITE_APP_STICKIES_URL as string;
export const CHAT_APP_URL = import.meta.env.VITE_APP_CHAT_URL as string;
export const SLIDES_APP_URL = import.meta.env.VITE_APP_SLIDES_URL as string;
export const SHEETS_APP_URL = import.meta.env.VITE_APP_SHEETS_URL as string;
export const PEOPLE_APP_URL = import.meta.env.VITE_APP_PEOPLE_URL as string;

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '');

const joinAppUrl = (baseUrl: string, path?: string) => {
    const cleanBase = trimTrailingSlash(baseUrl);
    if (!path) return cleanBase;
    return `${cleanBase}/${path.replace(/^\/+/, '')}`;
};

export const getSpaceAppUrl = (path?: string) => joinAppUrl(SPACE_APP_URL, path);
export const getMailAppUrl = (path?: string) => joinAppUrl(MAIL_APP_URL, path);
export const getContactsAppUrl = (path?: string) => joinAppUrl(CONTACTS_APP_URL, path);
export const getDriveAppUrl = (path?: string) => joinAppUrl(DRIVE_APP_URL, path);
export const getDocsAppUrl = (path?: string) => joinAppUrl(DOCS_APP_URL, path);
export const getStickiesAppUrl = (path?: string) => joinAppUrl(STICKIES_APP_URL, path);
export const getChatAppUrl = (path?: string) => joinAppUrl(CHAT_APP_URL, path);
export const getSlidesAppUrl = (path?: string) => joinAppUrl(SLIDES_APP_URL, path);
export const getSheetsAppUrl = (path?: string) => joinAppUrl(SHEETS_APP_URL, path);

export const getChatRoomUrl = (ownerId: string, mountId: string, chatId: string) =>
    getChatAppUrl(`${ownerId}/${mountId}/${chatId}`);

export const getDocUrl = (ownerId: string, mountId: string, pathId: string) =>
    getDocsAppUrl(`doc/${ownerId}/${mountId}/${pathId}`);

export const getStickiesBoardUrl = (ownerId: string, mountId: string, pathId: string) =>
    getStickiesAppUrl(`board/${ownerId}/${mountId}/${pathId}`);

export const getSlideUrl = (ownerId: string, mountId: string, pathId: string) =>
    getSlidesAppUrl(`slide/${ownerId}/${mountId}/${pathId}`);

export const getSheetUrl = (ownerId: string, mountId: string, pathId: string) =>
    getSheetsAppUrl(`sheet/${ownerId}/${mountId}/${pathId}`);

export const getMailComposeUrl = (address: string) =>
    getMailAppUrl(`box/inbox?mode=compose&to=${encodeURIComponent(address)}`);

export const getSpaceProfileUrl = () => getSpaceAppUrl('user');
export const getSpacePasswordUrl = () => getSpaceAppUrl('security/password');
export const getSpaceLogin2faUrl = (search: string = '') => `${getSpaceAppUrl('login-2fa')}${search}`;

export const getPublicAvatarUrl = (emailOrId: string) => `${API_HOST}/p/avatar/${encodeURIComponent(emailOrId)}`;
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