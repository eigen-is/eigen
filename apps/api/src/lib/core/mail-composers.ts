import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { buildAttachmentUrl, renderEigenEmail } from './mail-template';
import type { OutboundMail } from './mailer';

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
        from: { name: actor.name, address: actor.email },
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
        ? `<div style="margin-top:12px;padding:12px;border-left:3px solid #e0e0e0;color:#1a1a1a;font-size:14px;line-height:1.5">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`
        : '';
    const reference = pathAsAttachmentLink(path);
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(requesterDisplay)} (<a href="mailto:${escapeHtml(requester.email)}" style="color:#1a73e8">${escapeHtml(requester.email)}</a>) is requesting access. Open the document and grant them access from the share dialog.</p>${messageBlock}`,
        attachmentLinks: [reference],
        footerLine: `Access request from ${requesterDisplay}`,
    });
    const textParts = [`${requesterDisplay} requested access to "${displayName}".`];
    if (message) textParts.push(`Message: ${message}`);
    textParts.push(buildAttachmentUrl(reference));
    return {
        from: { name: requester.name, address: requester.email },
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
        from: { name: sender.name, address: sender.email },
        to: [{ name: '', address: recipientEmail }],
        subject: resolvedSubject,
        text: `${textBody}\n\n${buildAttachmentUrl(reference, recipientEmail)}`,
        html,
    };
}
