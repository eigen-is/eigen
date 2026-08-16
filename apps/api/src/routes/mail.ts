import type { SentMailResult } from '@workspace/lib/types/mail';
import { Elysia, t } from 'elysia';
import { contentDisposition, setCacheHeaders } from '../lib/core';
import { requireLocalhost, requireNonGuest, requireSelf } from '../lib/core/access';
import {
    attachFromDrive,
    getMailClient,
    mailboxDeliver,
    messageGet,
    messageMoveToTrash,
    saveAttachmentsToDrive,
    uploadDraftAttachment,
} from '../lib/mail/mail';
import { MAX_SEND_REFERENCES } from '../lib/mail/recipients';
import { betterAuth } from './auth';
import { attachmentReferenceSchema } from './shared-schemas';

const EmailAddressSchema = t.Object({
    address: t.Optional(t.String()),
    name: t.String(),
    group: t.Optional(t.Array(t.Object({ address: t.Optional(t.String()), name: t.String() }))),
});

const AddressObjectSchema = t.Object({
    value: t.Array(EmailAddressSchema),
    html: t.String(),
    text: t.String(),
});

const MailDraftSchema = t.Object({
    id: t.Optional(t.String()),
    subject: t.Optional(t.String()),
    from: t.Optional(AddressObjectSchema),
    to: t.Optional(AddressObjectSchema),
    cc: t.Optional(AddressObjectSchema),
    bcc: t.Optional(AddressObjectSchema),
    text: t.Optional(t.String()),
    html: t.Optional(t.String()),
    messageId: t.Optional(t.String()),
    inReplyTo: t.Optional(t.String()),
    references: t.Optional(t.Union([t.Array(t.String()), t.String()])),
    driveReferences: t.Optional(t.Array(attachmentReferenceSchema, { maxItems: MAX_SEND_REFERENCES })),
});

export const mailRouter = new Elysia({ name: 'mail' })
    .use(betterAuth)
    // Local delivery endpoint — called by Postfix (or compatible MTA) to deliver incoming mail.
    // No auth: Postfix connects from localhost and is trusted.
    .post(
        '/mail/deliver/:to',
        async ({ params, body, request, server }) => {
            requireLocalhost(request, server);
            return await mailboxDeliver(params.to, body as ArrayBuffer);
        },
        {
            parse: 'arrayBuffer',
            body: t.Any({ maxLength: 25 * 1024 * 1024 }), // 25 MB per-message size limit
        },
    )
    // All authenticated mail routes require ownerId === user.id (mail is personal-only, no shared access)
    .get(
        '/mail/:ownerId/mailboxes',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).mailboxesList();
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/mailbox/:mailboxPath',
        async ({ params, query, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).mailboxGet(params.mailboxPath, query);
        },
        {
            auth: true,
            query: t.Object({
                limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
                beforeDate: t.Optional(t.Integer()),
                beforeId: t.Optional(t.String()),
            }),
        },
    )
    .post(
        '/mail/:ownerId/mailbox',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).mailboxCreate(body.mailbox);
        },
        {
            auth: true,
            body: t.Object({ mailbox: t.String() }),
        },
    )
    .get(
        '/mail/:ownerId/mailbox-exists/:mailboxPath',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).mailboxExists(params.mailboxPath);
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/message/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await messageGet(user, params.id);
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/message/:id/download',
        async ({ params, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            setCacheHeaders(set, 86400);
            set.headers['Content-Type'] = 'message/rfc822';
            set.headers['Content-Transfer-Encoding'] = 'binary';
            set.headers['Content-Disposition'] = contentDisposition('attachment', `${params.id}.eml`);
            return await (await getMailClient(user)).messageGetFile(params.id);
        },
        { auth: true },
    )
    .delete(
        '/mail/:ownerId/message/:id',
        async ({ params, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageDelete(params.id);
        },
        { auth: true },
    )
    .put(
        '/mail/:ownerId/message/move',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageMove(body.messageId, body.targetMailbox);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String(), targetMailbox: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/move-to-trash',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await messageMoveToTrash(user, body.messageId);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String() }),
        },
    )
    .post(
        '/mail/:ownerId/message/copy',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageCopy(body.messageId, body.targetMailbox);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String(), targetMailbox: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/draft',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageHandleDraft(body.mail, {
                tempAttachmentIds: body.tempAttachmentIds,
                keepAttachmentIndexes: body.keepAttachmentIndexes,
                forceFullSave: body.forceFullSave,
            });
        },
        {
            auth: true,
            body: t.Object({
                mail: MailDraftSchema,
                tempAttachmentIds: t.Optional(t.Array(t.String())),
                keepAttachmentIndexes: t.Optional(t.Array(t.Integer())),
                forceFullSave: t.Optional(t.Boolean()),
            }),
        },
    )
    .post(
        '/mail/:ownerId/message/draft/attachment',
        async ({ params, user, request }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await uploadDraftAttachment(user, request);
        },
        {
            auth: true,
            parse: 'none',
        },
    )
    .post(
        '/mail/:ownerId/message/draft/attachment-from-drive',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await attachFromDrive(user, body.sourceOwnerId, body.sourceMountId, body.sourcePathId);
        },
        {
            auth: true,
            body: t.Object({
                sourceOwnerId: t.String(),
                sourceMountId: t.String(),
                sourcePathId: t.String(),
            }),
        },
    )
    .post(
        '/mail/:ownerId/message/send',
        async ({ params, body, user }): Promise<SentMailResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageSend(body.mail, {
                grantAccessRefIds: body.grantAccessRefIds,
            });
        },
        {
            auth: true,
            body: t.Object({
                mail: MailDraftSchema,
                grantAccessRefIds: t.Optional(t.Array(t.String(), { maxItems: MAX_SEND_REFERENCES })),
            }),
        },
    )
    .put(
        '/mail/:ownerId/message/:id/read',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageSetRead(params.id, body.read);
        },
        {
            auth: true,
            body: t.Object({ read: t.Boolean() }),
        },
    )
    .put(
        '/mail/:ownerId/message/:id/flagged',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await (await getMailClient(user)).messageSetFlagged(params.id, body.flagged);
        },
        {
            auth: true,
            body: t.Object({ flagged: t.Boolean() }),
        },
    )
    .post(
        '/mail/:ownerId/message/:id/attachments/save-to-drive',
        async ({ params, body, user }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return await saveAttachmentsToDrive(
                user,
                params.id,
                body.indexes,
                body.targetOwnerId,
                body.targetMountId,
                body.targetParentId,
            );
        },
        {
            auth: true,
            body: t.Object({
                indexes: t.Array(t.Integer()),
                targetOwnerId: t.String(),
                targetMountId: t.String(),
                targetParentId: t.String(),
            }),
        },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/:fileName',
        async ({ params, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            setCacheHeaders(set, 86400);
            set.headers['Content-Type'] = 'application/octet-stream';
            set.headers['Content-Disposition'] = contentDisposition('attachment', params.fileName);
            const attachment = await (await getMailClient(user)).messageGetAttachment(params.id, params.index);
            return attachment?.content ?? null;
        },
        {
            auth: true,
            params: t.Object({
                ownerId: t.String(),
                id: t.String(),
                index: t.Integer(),
                fileName: t.String(),
            }),
        },
    );
