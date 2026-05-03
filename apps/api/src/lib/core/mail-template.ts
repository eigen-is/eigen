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
import { getDomain } from '../config/server-config';

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
    cta?: { label: string; href: string };
    footerLine?: string;
};

function appUrl(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

function buildReferenceUrl(ref: AttachmentReference): string | undefined {
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
    if (isFolderType(ref.driveType)) {
        return `${appUrl('VITE_APP_DRIVE_URL', 'http://localhost:3002/drive')}/fs/${path}`;
    }
    return undefined;
}

export function renderAttachmentPills(references: AttachmentReference[]): string {
    const cards: string[] = [];
    for (const ref of references) {
        const href = buildReferenceUrl(ref);
        if (!href) continue;
        const name = escapeHtml(stripEigenExtension(ref.name));
        cards.push(
            `<div style="display:inline-block;border:1px solid ${EMAIL_BORDER};border-radius:6px;padding:6px 10px;margin:4px 4px 4px 0;font-size:13px;font-family:${EMAIL_FONT};color:#333;text-decoration:none;">` +
                `<a href="${escapeHtml(href)}" style="color:#333;text-decoration:none;">${PAPERCLIP_SVG}${name}</a>` +
                '</div>',
        );
    }
    if (cards.length === 0) return '';
    return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;">${cards.join('')}</div>`;
}

function renderCta(cta: { label: string; href: string }): string {
    return `<div style="margin-top:20px"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:${EMAIL_LINK};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:500;font-family:${EMAIL_FONT}">${escapeHtml(cta.label)}</a></div>`;
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

export function renderEigenEmail(input: EmailShellInput): string {
    const banner = input.banner ? renderBanner(input.banner) : '';
    const cta = input.cta ? renderCta(input.cta) : '';
    const pills = input.attachmentLinks?.length ? renderAttachmentPills(input.attachmentLinks) : '';
    const footer = input.footerLine ? renderFooter(input.footerLine) : '';
    const title = `<h2 style="margin:0 0 20px;font-size:18px;font-weight:600;color:${EMAIL_TEXT};font-family:${EMAIL_FONT}">${escapeHtml(input.title)}</h2>`;
    return `<div style="font-family:${EMAIL_FONT};padding:0 16px">
  <div style="border:1px solid ${EMAIL_BORDER};border-radius:${EMAIL_RADIUS};padding:24px;margin:16px 0;color:${EMAIL_TEXT}">
    ${banner}${title}
    ${input.bodyHtml}
    ${cta}
    ${pills}
  </div>
  ${footer}
</div>`;
}
