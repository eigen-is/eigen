import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import { renderEigenEmail } from './mail-template';
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
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(actorDisplay)} shared a document with you. Open it from the link below.</p>`,
        attachmentLinks: [pathAsAttachmentLink(path)],
        footerLine: `Shared by ${actorDisplay}`,
    });
    return {
        from: { name: actor.name, address: actor.email },
        to: [{ name: '', address: recipientEmail }],
        subject,
        text: `${actorDisplay} shared "${displayName}" with you.`,
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
    const html = renderEigenEmail({
        title: subject,
        bodyHtml: `<p style="font-size:14px;line-height:1.5">${escapeHtml(requesterDisplay)} (<a href="mailto:${escapeHtml(requester.email)}" style="color:#1a73e8">${escapeHtml(requester.email)}</a>) is requesting access. Open the document and grant them access from the share dialog.</p>${messageBlock}`,
        attachmentLinks: [pathAsAttachmentLink(path)],
        footerLine: `Access request from ${requesterDisplay}`,
    });
    const textParts = [`${requesterDisplay} requested access to "${displayName}".`];
    if (message) textParts.push(`Message: ${message}`);
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
    htmlMessage: string,
    documentLink: string,
    sender: { name: string; email: string },
    recipientEmail: string,
): OutboundMail {
    const displayName = stripEigenExtension(path.name);
    const senderDisplay = sender.name || sender.email;
    const html = renderEigenEmail({
        title: displayName,
        bodyHtml: htmlMessage,
        attachmentLinks: [pathAsAttachmentLink(path)],
        footerLine: `Sent from ${senderDisplay}`,
    });
    const textBody = stripTagsServer(htmlMessage);
    return {
        from: { name: sender.name, address: sender.email },
        to: [{ name: '', address: recipientEmail }],
        subject: displayName,
        text: `${textBody}\n\n${documentLink}`,
        html,
    };
}
