import { escapeHtml } from '@workspace/lib/html';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_DOC,
    DRIVE_TYPE_SHEETS,
    DRIVE_TYPE_SLIDES,
    DRIVE_TYPE_STICKIES,
    isFolderType,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { getDomain, isInternalAddress } from '../config/server-config';

const EMAIL_BORDER = '#e0e0e0';
const EMAIL_TEXT = '#1a1a1a';
const EMAIL_MUTED = '#5f6368';
const EMAIL_LINK = '#1a73e8';
const EMAIL_BANNER_BG = '#fce8e6';
const EMAIL_BANNER_FG = '#c5221f';
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const EMAIL_RADIUS = '8px';

const PAPERCLIP_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;">' +
    '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>' +
    '</svg>';

export type EmailShellInput = {
    title: string;
    bodyHtml: string;
    banner?: string;
    attachmentLinks?: AttachmentReference[];
    footerLine?: string;
    // Pill URLs for external recipients gain a `?email=` suffix so the guest-OTP
    // login page can pre-fill the address. No-op for users on this server's mail domain.
    recipientEmail?: string;
};

// Frontend per-app URLs are relative in production (e.g. "/docs"). Outbound emails need
// absolute URLs — recipients click them from their inbox, where window.location is not us.
// Resolve against API_URL (the public absolute origin written by setup).
function appUrl(name: string, fallback: string): string {
    const value = process.env[name] || fallback;
    if (/^https?:\/\//.test(value)) return value;
    const base = process.env['API_URL'] || 'http://localhost:8000';
    return `${base}${value.startsWith('/') ? value : `/${value}`}`;
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
        case DRIVE_TYPE_CHAT:
            return `${appUrl('VITE_APP_CHAT_URL', 'http://localhost:3008/chat')}/${path}`;
    }
    const driveBase = appUrl('VITE_APP_DRIVE_URL', 'http://localhost:3002/drive');
    if (isFolderType(ref.driveType)) {
        return `${driveBase}/fs/${path}`;
    }
    return `${driveBase}/shared/with-me?pid=${encodeURIComponent(ref.id)}&uid=${encodeURIComponent(ref.ownerId)}&mid=${encodeURIComponent(ref.mountId)}`;
}

// External recipients get a `?email=` suffix on the link so the guest-OTP login
// page can pre-fill their address. Same-domain recipients (already Eigen users)
// see the bare URL.
export function buildAttachmentUrl(ref: AttachmentReference, recipientEmail?: string): string {
    const url = buildReferenceUrl(ref);
    if (!recipientEmail || isInternalAddress(recipientEmail)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}email=${encodeURIComponent(recipientEmail)}`;
}

export function renderAttachmentPills(references: AttachmentReference[], recipientEmail?: string): string {
    const cards: string[] = [];
    for (const ref of references) {
        const href = buildAttachmentUrl(ref, recipientEmail);
        const name = escapeHtml(stripEigenExtension(ref.name));
        cards.push(
            `<div style="display:inline-block;border:1px solid ${EMAIL_BORDER};border-radius:6px;padding:6px 10px;margin:4px 4px 4px 0;font-size:13px;font-family:${EMAIL_FONT};color:#333;text-decoration:none;">` +
                `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="color:#333;text-decoration:none;">${PAPERCLIP_SVG}Open ${name} →</a>` +
                '</div>',
        );
    }
    if (cards.length === 0) return '';
    return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid ${EMAIL_BORDER};">${cards.join('')}</div>`;
}

function renderBanner(banner: string): string {
    return `<div style="background:${EMAIL_BANNER_BG};color:${EMAIL_BANNER_FG};font-weight:600;font-size:13px;padding:8px 12px;border-radius:4px;margin-bottom:16px">${escapeHtml(banner)}</div>`;
}

function renderFooter(footerLine: string): string {
    const domain = getDomain();
    const domainLink =
        domain === 'localhost'
            ? 'Eigen'
            : `<a href="https://${domain}" style="color:${EMAIL_LINK};text-decoration:none">Eigen</a>`;
    return `<div style="font-size:12px;color:${EMAIL_MUTED};padding:0 4px;margin-top:8px">${escapeHtml(footerLine)} · ${domainLink}</div>`;
}

// Wraps bare http(s) URLs in `<a href>` so admin-templated bodies (welcome, invite) get
// clickable links even when the template stores the URL as plain text. URLs already inside
// an existing `<a>...</a>` block are passed through; URLs inside double-quoted attribute
// values (e.g. `<img src="…">`) are skipped via the negative lookbehind.
function autolinkUrls(html: string): string {
    return html.replace(
        /(<a\s[^>]*>[\s\S]*?<\/a>)|(?<!["'])\b(https?:\/\/[^\s<>"']+)/gi,
        (_, anchor, url) => anchor ?? `<a href="${url}" style="color:${EMAIL_LINK}">${url}</a>`,
    );
}

export function renderEigenEmail(input: EmailShellInput): string {
    const banner = input.banner ? renderBanner(input.banner) : '';
    const pills = input.attachmentLinks?.length
        ? renderAttachmentPills(input.attachmentLinks, input.recipientEmail)
        : '';
    const footer = input.footerLine ? renderFooter(input.footerLine) : '';
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
