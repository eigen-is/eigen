import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import {
    buildAttachmentUrl,
    EMAIL_BORDER,
    EMAIL_LINK,
    EMAIL_MUTED,
    EMAIL_TEXT,
    renderEigenEmail,
} from './mail-template';
import { type OutboundMail, onBehalfOf } from './mailer';

function pathAsAttachmentLink(path: DrivePath): AttachmentReference {
    return {
        type: 'reference',
        id: path.id,
        ownerId: path.ownerId,
        mountId: path.mountId,
        name: path.name,
        driveType: path.type,
        mimeType: path.mimeType,
    };
}

export function composeShareEmail(
    path: DrivePath,
    recipientEmail: string,
    actor: { name: string; email: string },
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const actorDisplay = actor.name || actor.email;
    const subject = `${actorDisplay} shared "${displayName}" with you`;
    const reference = pathAsAttachmentLink(path);
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(actorDisplay)} shared a document with you. Open it from the link below.</p>`,
        attachmentLinks: [reference],
        footerLine: `Shared by ${actorDisplay}`,
        recipientEmail,
    });
    return {
        ...onBehalfOf({ name: actor.name, address: actor.email }),
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: `${actorDisplay} shared "${displayName}" with you.\n\n${buildAttachmentUrl(reference, recipientEmail)}`,
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
    const messageBlock = message
        ? `<div style="margin-top:12px;padding:12px;border-left:3px solid ${EMAIL_BORDER};color:${EMAIL_TEXT};font-size:14px;line-height:1.5">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`
        : '';
    const reference = pathAsAttachmentLink(path);
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(requesterDisplay)} (<a href="mailto:${escapeHtml(requester.email)}" style="color:${EMAIL_LINK}">${escapeHtml(requester.email)}</a>) is requesting access. Open the document and grant them access from the share dialog.</p>${messageBlock}`,
        attachmentLinks: [reference],
        footerLine: `Access request from ${requesterDisplay}`,
    });
    const textParts = [`${requesterDisplay} requested access to "${displayName}".`];
    if (message) textParts.push(`Message: ${message}`);
    textParts.push(buildAttachmentUrl(reference));
    return {
        ...onBehalfOf({ name: requester.name, address: requester.email }),
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
    const reference = pathAsAttachmentLink(path);
    const html = renderEigenEmail({
        title: resolvedSubject,
        bodyHtml: htmlMessage,
        attachmentLinks: [reference],
        footerLine: `Sent from ${senderDisplay}`,
        recipientEmail,
    });
    const textBody = stripTagsServer(htmlMessage);
    return {
        ...onBehalfOf({ name: sender.name, address: sender.email }),
        to: [{ name: '', address: recipientEmail }],
        subject: resolvedSubject,
        text: `${textBody}\n\n${buildAttachmentUrl(reference, recipientEmail)}`,
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
            : 'This code expires in 5 minutes. If you asked for more than one, only the newest works.';
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
        recipientEmail,
    });
    return {
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: stripTagsServer(bodyHtml),
        html,
    };
}
