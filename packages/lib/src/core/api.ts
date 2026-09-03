import type { app } from '@apps/api';
import { treaty } from '@elysiajs/eden';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    DRIVE_TYPE_VECTOR,
    type DriveItemRef,
    type DrivePath,
    isFolderType,
    isInlineEditable,
} from '../types/drive';

// Resolve API host to an absolute URL. A relative VITE_API_HOST (e.g. "/eigen") gets
// prefixed with window.location.origin at module load — that lets the same bundle work
// when accessed via the public domain, a LAN IP, a tunnel, etc. Absolute values
// (e.g. "http://localhost:8000" in dev) are passed through unchanged. WebSocket and SSE
// helpers below depend on this being absolute.
function resolveApiHost(): string {
    const raw = import.meta.env.VITE_API_HOST || '';
    if (/^https?:\/\//.test(raw)) return raw;
    if (typeof window === 'undefined') {
        // SSR / unit-test evaluation: no window.origin to splice in. Synthesize a valid
        // absolute URL with protocol so module-load-time consumers (treaty, better-auth's
        // URL validator) don't reject it. The browser bundle re-resolves at runtime.
        return `http://localhost${raw.startsWith('/') ? raw : raw ? `/${raw}` : ''}`;
    }
    return `${window.location.origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

export const API_HOST = resolveApiHost();

// Protocol surfaces live on the API's public origin, not under the API path prefix: the bundled
// Caddyfiles serve /dav/* at the origin root (where /.well-known/caldav redirects) and IMAP/SMTP
// listen on the hostname, while a bare dev API serves /dav on its own origin directly.
export const SERVER_HOSTNAME = new URL(API_HOST).hostname;
export const DAV_HOST = `${new URL(API_HOST).origin}/dav`;

export const api = treaty<app>(API_HOST, {
    fetch: {
        credentials: 'include',
    },
});

// The one treaty without date revival: a birthday is a date-only string ("1990-01-01") and reviving it
// into a Date shifts the day by timezone. Deliberate break from the Date wire convention, pinned by api.test.ts.
export const contactsApi = treaty<app>(API_HOST, {
    fetch: {
        credentials: 'include',
    },
    parseDate: false,
}).contacts;
export const mailApi = api.mail;
export const publicApi = api.p;
export const driveApi = api.drive;
export const homeApi = api.home;
export const chatApi = api.chat;
export const collabApi = api.collab;
export const calendarApi = api.calendar;
export const spaceApi = api.space;
export const teamApi = api.team;
export const notificationApi = api.notifications;
export const searchApi = api.search;
export const settingsApi = api.settings;
export const setupApi = api.setup;
export const waitlistApi = api.waitlist;

// Read at module scope and fed to trimTrailingSlash, so a var missing from
// .env.production used to throw before anything rendered — a blank page whose only
// symptom was `TypeError: reading 'replace'`. A deployment generated before an app
// existed hits exactly that until update.sh backfills it. Unset now degrades to a
// same-origin relative link, which is what production serves anyway.
export const SPACE_APP_URL = import.meta.env.VITE_APP_SPACE_URL ?? '';
export const MAIL_APP_URL = import.meta.env.VITE_APP_MAIL_URL ?? '';
export const CONTACTS_APP_URL = import.meta.env.VITE_APP_CONTACTS_URL ?? '';
export const DRIVE_APP_URL = import.meta.env.VITE_APP_DRIVE_URL ?? '';
export const DOCS_APP_URL = import.meta.env.VITE_APP_DOCS_URL ?? '';
export const STICKIES_APP_URL = import.meta.env.VITE_APP_STICKIES_URL ?? '';
export const CHAT_APP_URL = import.meta.env.VITE_APP_CHAT_URL ?? '';
export const SLIDES_APP_URL = import.meta.env.VITE_APP_SLIDES_URL ?? '';
export const SHEETS_APP_URL = import.meta.env.VITE_APP_SHEETS_URL ?? '';
export const VECTOR_APP_URL = import.meta.env.VITE_APP_VECTOR_URL ?? '';
export const CALENDAR_APP_URL = import.meta.env.VITE_APP_CALENDAR_URL ?? '';
export const ADMIN_APP_URL = import.meta.env.VITE_APP_ADMIN_URL ?? '';
// Only set in dev, where each app runs on its own port. In production the index app is
// served same-origin at root, so an unset value falls back to a relative `/support` link.
export const INDEX_APP_URL = import.meta.env.VITE_APP_INDEX_URL ?? '';

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
export const getVectorAppUrl = (path?: string) => joinAppUrl(VECTOR_APP_URL, path);
export const getCalendarAppUrl = (path?: string) => joinAppUrl(CALENDAR_APP_URL, path);
export const getAdminAppUrl = (path?: string) => joinAppUrl(ADMIN_APP_URL, path);
export const getIndexAppUrl = (path?: string) => joinAppUrl(INDEX_APP_URL, path);

const getChatRoomUrl = (ownerId: string, mountId: string, chatId: string) =>
    getChatAppUrl(`${ownerId}/${mountId}/${chatId}`);

const getDocUrl = (ownerId: string, mountId: string, pathId: string) =>
    getDocsAppUrl(`doc/${ownerId}/${mountId}/${pathId}`);

const getStickiesBoardUrl = (ownerId: string, mountId: string, pathId: string) =>
    getStickiesAppUrl(`board/${ownerId}/${mountId}/${pathId}`);

const getSlideUrl = (ownerId: string, mountId: string, pathId: string) =>
    getSlidesAppUrl(`slide/${ownerId}/${mountId}/${pathId}`);

const getSheetUrl = (ownerId: string, mountId: string, pathId: string) =>
    getSheetsAppUrl(`sheet/${ownerId}/${mountId}/${pathId}`);

const getVectorUrl = (ownerId: string, mountId: string, pathId: string) =>
    getVectorAppUrl(`vector/${ownerId}/${mountId}/${pathId}`);

export const getMailComposeUrl = (address: string) =>
    getMailAppUrl(`box/inbox?mode=compose&to=${encodeURIComponent(address)}`);

// Cross-app entry into the Mail composer. `to` prefills the recipient. `attachments`
// passes the full `ownerId/mountId/pathId` tuple per item in the URL so the Mail
// route can re-fetch each DrivePath, build an AttachmentReference, and seed the
// composer with `driveReferences` — same flow Reply/Forward uses via history state.
export function openMailComposeWith(opts: { to?: string; attachments?: DrivePath[] }): void {
    const params = new URLSearchParams({ mode: 'compose' });
    if (opts.to) params.set('to', opts.to);
    if (opts.attachments?.length) {
        params.set('attach', opts.attachments.map((a) => `${a.ownerId}/${a.mountId}/${a.id}`).join(','));
    }
    window.location.href = getMailAppUrl(`box/inbox?${params}`);
}

export const getSpaceProfileUrl = () => getSpaceAppUrl('user');
export const getSpacePasswordUrl = () => getSpaceAppUrl('security/password');
export const getSupportUrl = () => getIndexAppUrl('support');
export const getLicensesUrl = () => getIndexAppUrl('licenses');
export const getChangelogUrl = () => getIndexAppUrl('changelog');
export const getSpaceLogin2faUrl = (search: string = '') => `${getSpaceAppUrl('login-2fa')}${search}`;

export const getPublicAvatarUrl = (emailOrId: string) => `${API_HOST}/p/avatar/${encodeURIComponent(emailOrId)}`;
// Demo-instance entry: mints a random seeded persona session and 302s into the app.
export const getDemoEnterUrl = () => `${API_HOST}/p/demo/enter`;
export const getSSEEventsUrl = (ownerId: string) => `${API_HOST}/sse/${ownerId}/events`;
export const getContactsAvatarUploadUrl = (ownerId: string) => `${API_HOST}/contacts/${ownerId}/avatar`;
export const getDriveFileUploadUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}`;
export const getMailDraftAttachmentUploadUrl = (ownerId: string) =>
    `${API_HOST}/mail/${ownerId}/message/draft/attachment`;
export const getDriveDownloadUrl = (ownerId: string, mountId: string, pathId: string, updatedAt?: Date) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/download${updatedAt ? `?v=${updatedAt.getTime()}` : ''}`;
export const getDriveExportUrl = (ownerId: string, mountId: string, pathId: string, format: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/export/${format}`;
export const getDriveImportUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/import`;
export const getDriveImportFromDriveUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/import-from-drive`;

export const getDriveEmbedUrl = (
    ownerId: string,
    mountId: string,
    pathId: string,
    fileName: string,
    updatedAt?: Date,
) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/embed/${fileName}${updatedAt ? `?v=${updatedAt.getTime()}` : ''}`;
export const getDrivePreviewUrl = (ownerId: string, mountId: string, pathId: string, updatedAt?: Date) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/file/${pathId}/preview${updatedAt ? `?v=${updatedAt.getTime()}` : ''}`;
export const getDriveThumbnailUrl = (ownerId: string, mountId: string, fileName: string, updatedAt?: Date) =>
    `${API_HOST}/drive/${ownerId}/${mountId}/thumb/${fileName}${updatedAt ? `?v=${updatedAt.getTime()}` : ''}`;
// Cache-busted thumbnail for image/video items — shared by grid tiles and the preview panel.
// Trashed items get none: the thumb route rejects paths in trash (getActivePath).
export const getDriveItemThumbnail = (path: DrivePath): { showThumbnail: boolean; thumbnailUrl?: string } => {
    const hasVisual = path.mimeType.startsWith('image/') || path.mimeType.startsWith('video/');
    const thumbnailUrl =
        path.thumbnail && !path.trashedAt
            ? getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail, path.updatedAt)
            : undefined;
    return { showThumbnail: hasVisual && !!thumbnailUrl, thumbnailUrl };
};
export const getCollabWebSocketUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST.replace('http', 'ws')}/ws/collab/${ownerId}/${mountId}/${pathId}`;
export const getInlineEditUrl = (ownerId: string, mountId: string, pathId: string) =>
    getDriveAppUrl(`edit/${ownerId}/${mountId}/${pathId}`);
export const getMailMessageDownloadUrl = (ownerId: string, messageId: string) =>
    `${API_HOST}/mail/${ownerId}/message/${messageId}/download`;
export const getMailAttachmentUrl = (ownerId: string, messageId: string, attachmentIndex: number, fileName: string) =>
    `${API_HOST}/mail/${ownerId}/message/${messageId}/attachment/${attachmentIndex}/${encodeURIComponent(fileName)}`;
export const getCollabAccessUrl = (ownerId: string, mountId: string, pathId: string) =>
    `${API_HOST}/collab/${ownerId}/${mountId}/${pathId}/access`;

function getDocumentUrl(path: DriveItemRef): string | undefined {
    if (path.type === DRIVE_TYPE_DOC) return getDocUrl(path.ownerId, path.mountId, path.id);
    if (path.type === DRIVE_TYPE_STICKIES) return getStickiesBoardUrl(path.ownerId, path.mountId, path.id);
    if (path.type === DRIVE_TYPE_SHEETS) return getSheetUrl(path.ownerId, path.mountId, path.id);
    if (path.type === DRIVE_TYPE_SLIDES) return getSlideUrl(path.ownerId, path.mountId, path.id);
    if (path.type === DRIVE_TYPE_VECTOR) return getVectorUrl(path.ownerId, path.mountId, path.id);
    if (path.type === DRIVE_TYPE_CHAT) return getChatRoomUrl(path.ownerId, path.mountId, path.id);
    return undefined;
}

export function openDocument(path: DrivePath, newTab: boolean = false) {
    const url = getDocumentUrl(path);
    if (!url) {
        console.warn('Cannot open document. Unsupported type:', path.type);
        return false;
    }
    if (newTab) {
        window.open(url, '_blank');
    } else {
        window.location.href = url;
    }
    return true;
}

export function getDriveItemUrl(path: DriveItemRef, opts?: { card?: string; chat?: string }): string | undefined {
    let url = getDocumentUrl(path);
    if (!url) {
        if (isFolderType(path.type)) {
            url = getDriveAppUrl(`fs/${path.ownerId}/${path.mountId}/${path.id}`);
        } else if (isInlineEditable(path.mimeType, path.name)) {
            url = getInlineEditUrl(path.ownerId, path.mountId, path.id);
        }
    }
    if (!url) return undefined;
    if (opts?.card) return `${url}?card=${encodeURIComponent(opts.card)}`;
    if (opts?.chat) return `${url}?chat=${encodeURIComponent(opts.chat)}`;
    return url;
}

export function getDriveShareUrl(path: DrivePath): string {
    return (
        getDriveItemUrl(path) ?? getDriveAppUrl(`shared/with-me?pid=${path.id}&uid=${path.ownerId}&mid=${path.mountId}`)
    );
}
