// The HTML shell that wraps every email Eigen sends: a card with a title, the body, an optional banner
// and a footer. It also renders links to Drive items as "Open …" pills. Their URLs are absolute and point
// into each app, because the recipient clicks them in an inbox, not in Eigen. adminUrl gives the same kind
// of absolute link to the admin app.

import { escapeHtml } from '@workspace/lib/html';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    DRIVE_TYPE_VECTOR,
    isFolderType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { getPublicOrigin, isInternalAddress } from '../config/server-config';

export const EMAIL_BORDER = '#e0e0e0';
export const EMAIL_TEXT = '#1a1a1a';
export const EMAIL_MUTED = '#5f6368';
export const EMAIL_LINK = '#1a73e8';
const EMAIL_PILL_TEXT = '#333';
const EMAIL_BANNER_BG = '#fce8e6';
const EMAIL_BANNER_FG = '#c5221f';
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const EMAIL_RADIUS = '8px';

const PAPERCLIP_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;">' +
    '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>' +
    '</svg>';

// One "Open {name} →" pill.
type EmailLink = { name: string; href: string };

type EmailShellInput = {
    title: string;
    bodyHtml: string;
    banner?: string;
    links?: readonly EmailLink[];
    footerLine?: string;
};

// A frontend app's URL is relative in production, such as "/docs", and a recipient clicks the link from their inbox. So
// it resolves against API_URL, the public origin setup writes.
function appUrl(name: string, fallback: string): string {
    const value = process.env[name] || fallback;
    if (/^https?:\/\//.test(value)) return value;
    const base = process.env['API_URL'] || 'http://localhost:8000';
    return `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

// The admin app, where setup finishes and the admins sign in.
export function adminUrl(): string {
    return appUrl('VITE_APP_ADMIN_URL', 'http://localhost:3009/admin');
}

function buildReferenceUrl(ref: AttachmentReference): string {
    const path = `${ref.ownerId}/${ref.mountId}/${ref.id}`;
    switch (ref.driveType) {
        case DRIVE_TYPE_DOC:
            return `${appUrl('VITE_APP_DOCS_URL', 'http://localhost:3006/docs')}/doc/${path}`;
        case DRIVE_TYPE_STICKIES:
            return `${appUrl('VITE_APP_STICKIES_URL', 'http://localhost:3007/stickies')}/board/${path}`;
        case DRIVE_TYPE_SLIDES:
            return `${appUrl('VITE_APP_SLIDES_URL', 'http://localhost:3012/slides')}/slide/${path}`;
        case DRIVE_TYPE_SHEETS:
            return `${appUrl('VITE_APP_SHEETS_URL', 'http://localhost:3013/sheets')}/sheet/${path}`;
        case DRIVE_TYPE_VECTOR:
            return `${appUrl('VITE_APP_VECTOR_URL', 'http://localhost:3014/vector')}/vector/${path}`;
        case DRIVE_TYPE_CHAT:
            return `${appUrl('VITE_APP_CHAT_URL', 'http://localhost:3008/chat')}/${path}`;
    }
    const driveBase = appUrl('VITE_APP_DRIVE_URL', 'http://localhost:3002/drive');
    if (isFolderType(ref.driveType)) {
        return `${driveBase}/fs/${path}`;
    }
    return `${driveBase}/shared/with-me?pid=${encodeURIComponent(ref.id)}&uid=${encodeURIComponent(ref.ownerId)}&mid=${encodeURIComponent(ref.mountId)}`;
}

// An external recipient's link carries `?email=`, so the guest login page can fill in their address.
export function buildAttachmentUrl(ref: AttachmentReference, recipientEmail?: string): string {
    const url = buildReferenceUrl(ref);
    if (!recipientEmail || isInternalAddress(recipientEmail)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}email=${encodeURIComponent(recipientEmail)}`;
}

function renderPills(links: readonly EmailLink[]): string {
    if (links.length === 0) return '';
    const cards = links.map(
        (link) =>
            `<div style="display:inline-block;border:1px solid ${EMAIL_BORDER};border-radius:6px;padding:6px 10px;margin:4px 4px 4px 0;font-size:13px;font-family:${EMAIL_FONT};color:${EMAIL_PILL_TEXT};text-decoration:none;">` +
            `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" style="color:${EMAIL_PILL_TEXT};text-decoration:none;">${PAPERCLIP_SVG}Open ${escapeHtml(link.name)} →</a>` +
            '</div>',
    );
    return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid ${EMAIL_BORDER};">${cards.join('')}</div>`;
}

export function renderAttachmentPills(references: readonly AttachmentReference[], recipientEmail?: string): string {
    return renderPills(
        references.map((ref) => ({
            name: stripEigenExtension(ref.name),
            href: buildAttachmentUrl(ref, recipientEmail),
        })),
    );
}

// Plain-text sibling of renderAttachmentPills for the text/plain alternative: one
// `name: url` line per reference, prefixed with a blank line to separate from the body.
export function renderAttachmentLinksText(references: AttachmentReference[], recipientEmail?: string): string {
    if (references.length === 0) return '';
    const lines = references.map(
        (ref) => `${stripEigenExtension(ref.name)}: ${buildAttachmentUrl(ref, recipientEmail)}`,
    );
    return `\n\n${lines.join('\n')}`;
}

// An admin's template may hold a URL as plain text. One already in an `<a>` passes through, and the lookbehind skips one in
// a quoted attribute, such as `<img src>`.
function autolinkUrls(html: string): string {
    return html.replace(
        /(<a\s[^>]*>[\s\S]*?<\/a>)|(?<!["'])\b(https?:\/\/[^\s<>"']+)/gi,
        (_, anchor, url) => anchor ?? `<a href="${url}" style="color:${EMAIL_LINK}">${url}</a>`,
    );
}

export function renderEigenEmail(input: EmailShellInput): string {
    const banner = input.banner
        ? `<div style="background:${EMAIL_BANNER_BG};color:${EMAIL_BANNER_FG};font-weight:600;font-size:13px;padding:8px 12px;border-radius:4px;margin-bottom:16px">${escapeHtml(input.banner)}</div>`
        : '';
    const pills = input.links ? renderPills(input.links) : '';
    let footer = '';
    if (input.footerLine) {
        const origin = getPublicOrigin();
        const domainLink = origin
            ? `<a href="${origin}" style="color:${EMAIL_LINK};text-decoration:none">Eigen</a>`
            : 'Eigen';
        footer = `<div style="font-size:12px;color:${EMAIL_MUTED};padding:0 4px;margin-top:8px">${escapeHtml(input.footerLine)} · ${domainLink}</div>`;
    }
    const title = `<h2 style="margin:0 0 20px;font-size:18px;font-weight:600;color:${EMAIL_TEXT};font-family:${EMAIL_FONT}">${escapeHtml(input.title)}</h2>`;
    return `<div style="font-family:${EMAIL_FONT};padding:0 16px">
  <div style="background:#ffffff;border:1px solid ${EMAIL_BORDER};border-radius:${EMAIL_RADIUS};padding:24px;margin:16px 0;color:${EMAIL_TEXT}">
    ${banner}${title}
    ${autolinkUrls(input.bodyHtml)}
    ${pills}
  </div>
  ${footer}
</div>`;
}
