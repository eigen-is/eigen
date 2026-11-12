// Builds the ready-made emails Eigen sends for its own features, such as a share notice, an access request
// or a sign-in code. Each returns an OutboundMail for sendMail: the HTML in the shared email shell, and a
// plain-text version of the same message.

import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { toAttachmentReference } from '@workspace/lib/types/drive-reference';
import {
    buildAttachmentUrl,
    EMAIL_BORDER,
    EMAIL_LINK,
    EMAIL_MUTED,
    EMAIL_TEXT,
    renderEigenEmail,
} from './mail-template';
import type { OutboundMail } from './mailer';

// Takes HTML, so the caller escapes what a person wrote.
function quoteBlock(html: string): string {
    return `<div style="margin-top:12px;padding:12px;border-left:3px solid ${EMAIL_BORDER};color:${EMAIL_TEXT};font-size:14px;line-height:1.5">${html}</div>`;
}

export function composeShareEmail(
    path: DrivePath,
    recipientEmail: string,
    actor: { name: string; email: string },
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const actorDisplay = actor.name || actor.email;
    const subject = `${actorDisplay} shared "${displayName}" with you`;
    const url = buildAttachmentUrl(toAttachmentReference(path), recipientEmail);
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(actorDisplay)} shared a document with you. Open it from the link below.</p>`,
        links: [{ name: displayName, href: url }],
        footerLine: `Shared by ${actorDisplay}`,
    });
    return {
        from: { name: actor.name, address: actor.email },
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: `${actorDisplay} shared "${displayName}" with you.\n\n${url}`,
        html,
    };
}

export function composeAssignedEmail(
    path: DrivePath,
    recipientEmail: string,
    actor: { name: string; email: string },
    chatName: string,
    card: string | undefined,
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const actorDisplay = actor.name || actor.email;
    const subject = `${actorDisplay} assigned you a task on "${displayName}"`;
    const url = new URL(buildAttachmentUrl(toAttachmentReference(path), recipientEmail));
    url.searchParams.set('chat', chatName);
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(actorDisplay)} assigned you a task. Open it from the link below.</p>${card ? quoteBlock(escapeHtml(card)) : ''}`,
        links: [{ name: displayName, href: url.toString() }],
        footerLine: `Assigned by ${actorDisplay}`,
    });
    const textParts = [`${actorDisplay} assigned you a task on "${displayName}".`];
    if (card) textParts.push(card);
    textParts.push(url.toString());
    return {
        from: { name: actor.name, address: actor.email },
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: textParts.join('\n\n'),
        html,
    };
}

export function composeAccessRequestEmail(
    path: DrivePath,
    owner: { name: string; email: string },
    requester: { name: string; email: string },
    message: string | null,
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const requesterDisplay = requester.name || requester.email;
    const subject = `${requesterDisplay} requested access to "${displayName}"`;
    const messageBlock = message ? quoteBlock(escapeHtml(message).replace(/\n/g, '<br>')) : '';
    const url = buildAttachmentUrl(toAttachmentReference(path));
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(requesterDisplay)} (<a href="mailto:${escapeHtml(requester.email)}" style="color:${EMAIL_LINK}">${escapeHtml(requester.email)}</a>) is requesting access. Open the document and grant them access from the share dialog.</p>${messageBlock}`,
        links: [{ name: displayName, href: url }],
        footerLine: `Access request from ${requesterDisplay}`,
    });
    const textParts = [`${requesterDisplay} requested access to "${displayName}".`];
    if (message) textParts.push(`Message: ${message}`);
    textParts.push(url);
    return {
        from: { name: requesterDisplay, address: requester.email },
        to: [{ name: owner.name, address: owner.email }],
        subject,
        text: textParts.join('\n\n'),
        html,
    };
}

export function composeCollaboratorsEmail(
    path: DrivePath,
    subject: string | null,
    htmlMessage: string,
    sender: { name: string; email: string },
    recipientEmail: string,
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const resolvedSubject = subject?.trim() || displayName;
    const senderDisplay = sender.name || sender.email;
    const url = buildAttachmentUrl(toAttachmentReference(path), recipientEmail);
    const html = renderEigenEmail({
        title: resolvedSubject,
        bodyHtml: htmlMessage,
        links: [{ name: displayName, href: url }],
        footerLine: `Sent from ${senderDisplay}`,
    });
    const textBody = stripTagsServer(htmlMessage);
    return {
        from: { name: sender.name, address: sender.email },
        to: [{ name: '', address: recipientEmail }],
        subject: resolvedSubject,
        text: `${textBody}\n\n${url}`,
        html,
    };
}

// System emails carry no from-address, so buildMailOptions stamps the system sender on them.
export function composeOtpEmail(
    recipient: { name: string; email: string },
    code: string,
    kind: '2fa' | 'guest',
    orgName: string,
    // The `@domain #code` trailer is what iOS Mail's Security Code AutoFill reads from the
    // text/plain part; 'localhost' skips it, since binding a code to localhost is meaningless.
    domain: string,
): OutboundMail {
    const subject = kind === '2fa' ? 'Your verification code' : 'Your guest access code';
    const intro =
        kind === '2fa'
            ? 'Use the code below to finish signing in:'
            : 'Use the code below to access your shared documents:';
    const expiry =
        kind === '2fa'
            ? 'This code expires in 5 minutes.'
            : 'This code expires in 15 minutes. If you asked for more than one, only the newest works.';
    const html = renderEigenEmail({
        title: subject,
        bodyHtml:
            `<p style="font-size:14px;line-height:1.5">${intro}</p>` +
            `<p style="font-family:ui-monospace,Menlo,monospace;font-size:28px;font-weight:600;letter-spacing:4px;margin:16px 0">${escapeHtml(code)}</p>` +
            `<p style="font-size:13px;color:${EMAIL_MUTED}">${expiry}</p>`,
        footerLine: orgName,
    });
    const lines = [`${intro.replace(/:$/, '')}: ${code}`, '', expiry];
    if (domain !== 'localhost') {
        lines.push('', `@${domain} #${code}`);
    }
    return {
        to: [{ name: recipient.name, address: recipient.email }],
        subject,
        text: lines.join('\n'),
        html,
    };
}

export function composeInviteEmail(
    recipientEmail: string,
    subject: string,
    bodyHtml: string,
    orgName: string,
): OutboundMail {
    const html = renderEigenEmail({
        title: subject,
        bodyHtml,
        footerLine: orgName,
    });
    return {
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: stripTagsServer(bodyHtml),
        html,
    };
}
