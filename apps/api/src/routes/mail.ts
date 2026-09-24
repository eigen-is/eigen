import { EML_MAX_BYTES, MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
import { EML_MIME, isEmlFile } from '@workspace/lib/types/drive';
import {
    type ImportMailResult,
    mailAttachmentName,
    type NewDraft,
    type SentMailResult,
} from '@workspace/lib/types/mail';
import { Elysia, type Static, t } from 'elysia';
import { ApiError, contentDisposition, NOT_AN_EMAIL_FILE, readBoundedBodyBytes, setCacheHeaders } from '../lib/core';
import { requireLocalhost, requireMailEnabled, requireNonGuest, requireSelf } from '../lib/core/access';
import { readImportSourceBytes } from '../lib/drive';
import {
    attachFromDrive,
    getMailClient,
    mailboxDeliver,
    messageGet,
    messageMoveToTrash,
    saveAttachmentsToDrive,
    uploadDraftAttachment,
} from '../lib/mail/mail';
import { answerMailPart, serveMailPart } from '../lib/mail/serve-mail-part';
import {
    assertEmlPreviewable,
    assertIcsPreviewable,
    assertVCardPreviewable,
    EML_FORMAT,
    getBytesEmlPreview,
    getBytesIcsPreview,
    getBytesTextPreview,
    getBytesVCardPreview,
    ICS_FORMAT,
    TEXT_FORMAT,
    VCARD_FORMAT,
} from '../lib/preview/preview-cache';
import { betterAuth } from './auth';
import { attachmentReferenceSchema, importFromDriveSchema } from './shared-schemas';

const EmailAddressSchema = t.Object({
    address: t.Optional(t.String()),
    name: t.String(),
    group: t.Optional(t.Array(t.Object({ address: t.Optional(t.String()), name: t.String() }))),
});

const AddressObjectSchema = t.Object({
    value: t.Array(EmailAddressSchema),
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
// Compile-time guard: a field added to NewDraft without a schema entry here would be stripped by Elysia's
// normalize, so the key sets must match (a structural `extends` check would not catch it).
type _MailDraftSchemaCoversNewDraft =
    Exclude<keyof NewDraft, keyof Static<typeof MailDraftSchema>> extends never ? true : never;
const _mailDraftSchemaCheck: _MailDraftSchemaCoversNewDraft = true;
void _mailDraftSchemaCheck;

// The :fileName segment is decoration: both byte routes take the served name from the part itself.
const AttachmentParamsSchema = t.Object({
    ownerId: t.String(),
    id: t.String(),
    index: t.Integer({ minimum: 0 }),
    fileName: t.String(),
});

// The preview routes address the same part, without that decoration.
const AttachmentPreviewParamsSchema = t.Omit(AttachmentParamsSchema, ['fileName']);

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
            // The per-message size cap is Postfix's `message_size_limit` (docker/postfix/main.cf.template).
            body: t.Any(),
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
            set.headers['Content-Type'] = EML_MIME;
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
            body: importFromDriveSchema,
        },
    )
    .post(
        '/mail/:ownerId/message/send',
        async ({ params, body, user }): Promise<SentMailResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            requireMailEnabled();
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
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return answerMailPart(await getMailClient(user), params.id, params.index, request, set, (att) =>
                serveMailPart(att, params.index, 'attachment', request.headers.get('range')),
            );
        },
        { auth: true, params: AttachmentParamsSchema },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/embed/:fileName',
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            return answerMailPart(await getMailClient(user), params.id, params.index, request, set, (att) =>
                serveMailPart(att, params.index, 'inline', request.headers.get('range')),
            );
        },
        { auth: true, params: AttachmentParamsSchema },
    )
    // Previews run the renderers Drive's preview routes end in, on the part's bytes; same shapes, same
    // components. Two segments after the index, like /embed/:fileName: a sender names the part, and a
    // one-segment preview route would be shadowed by a part called after it.
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/preview/text',
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const mail = await getMailClient(user);
            return answerMailPart(
                mail,
                params.id,
                params.index,
                request,
                set,
                async (att) => {
                    const name = mailAttachmentName(att, params.index);
                    const preview = await getBytesTextPreview(att.content, name, att.contentType, att.charset);
                    if (!preview) throw new ApiError(404, 'No preview available');
                    return preview;
                },
                TEXT_FORMAT,
            );
        },
        { auth: true, params: AttachmentPreviewParamsSchema },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/preview/vcard',
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const mail = await getMailClient(user);
            return answerMailPart(
                mail,
                params.id,
                params.index,
                request,
                set,
                (att) => {
                    assertVCardPreviewable(mailAttachmentName(att, params.index), att.contentType, att.size);
                    // A copy: content is a view over the whole parsed message, and the Worker detaches the buffer it gets.
                    return getBytesVCardPreview(new Uint8Array(att.content).buffer);
                },
                VCARD_FORMAT,
            );
        },
        { auth: true, params: AttachmentPreviewParamsSchema },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/preview/eml',
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const mail = await getMailClient(user);
            return answerMailPart(
                mail,
                params.id,
                params.index,
                request,
                set,
                (att) => {
                    assertEmlPreviewable(mailAttachmentName(att, params.index), att.contentType, att.size);
                    // A copy, for the reason the cards route copies: the Worker detaches the buffer it gets.
                    return getBytesEmlPreview(new Uint8Array(att.content).buffer);
                },
                EML_FORMAT,
            );
        },
        { auth: true, params: AttachmentPreviewParamsSchema },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/preview/ics',
        async ({ params, request, user, set }) => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            const mail = await getMailClient(user);
            return answerMailPart(
                mail,
                params.id,
                params.index,
                request,
                set,
                (att) => {
                    assertIcsPreviewable(mailAttachmentName(att, params.index), att.contentType, att.size);
                    // A copy, for the reason the cards route copies: the Worker detaches the buffer it gets.
                    return getBytesIcsPreview(new Uint8Array(att.content).buffer);
                },
                ICS_FORMAT,
            );
        },
        { auth: true, params: AttachmentPreviewParamsSchema },
    )
    .post(
        '/mail/:ownerId/import',
        async ({ params, request, user, server }): Promise<ImportMailResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            requireMailEnabled();
            // The whole message uploads, parses and indexes before this answers — at EML_MAX_BYTES
            // that outlasts any server-wide idleTimeout, so exempt this request.
            server?.timeout(request, 0);
            const bytes = await readBoundedBodyBytes(request, EML_MAX_BYTES);
            if (bytes === null) throw new ApiError(413, 'Upload too large');
            return await (await getMailClient(user)).messageImport(Buffer.from(bytes));
        },
        { auth: true, parse: 'none' },
    )
    .post(
        '/mail/:ownerId/import-from-drive',
        async ({ params, body, request, user, server }): Promise<ImportMailResult> => {
            requireNonGuest(user);
            requireSelf(params.ownerId, user.id);
            requireMailEnabled();
            // Same idle-timeout exemption as the raw import route: silent until the message is indexed.
            server?.timeout(request, 0);
            const bytes = await readImportSourceBytes(user, body, {
                accepts: isEmlFile,
                rejection: NOT_AN_EMAIL_FILE,
                maxBytes: EML_MAX_BYTES,
            });
            return await (await getMailClient(user)).messageImport(Buffer.from(bytes));
        },
        {
            body: importFromDriveSchema,
            auth: true,
        },
    );
