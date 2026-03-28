import { Elysia, t } from 'elysia';
import { contentDisposition } from '../lib/core';
import { requireLocalhost, requireSelf } from '../lib/core/access';
import {
    mailboxCreate,
    mailboxDeliver,
    mailboxExists,
    mailboxesList,
    mailboxGet,
    messageCopy,
    messageDelete,
    messageGet,
    messageGetAttachment,
    messageGetFile,
    messageHandleDraft,
    messageMove,
    messageMoveToArchive,
    messageMoveToInbox,
    messageMoveToSpam,
    messageMoveToTrash,
    messageSend,
    messageSetFlagged,
    messageSetRead,
} from '../lib/mail/mail';
import { betterAuth } from './auth';

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
            requireSelf(params.ownerId, user.id);
            return await mailboxesList(user);
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/mailbox/:mailboxPath',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            return await mailboxGet(user, params.mailboxPath);
        },
        { auth: true },
    )
    .post(
        '/mail/:ownerId/mailbox',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await mailboxCreate(user, body.mailbox);
        },
        {
            auth: true,
            body: t.Object({ mailbox: t.String() }),
        },
    )
    .get(
        '/mail/:ownerId/mailbox-exists/:mailboxPath',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            return await mailboxExists(user, params.mailboxPath);
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/message/:id',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageGet(user, params.id);
        },
        { auth: true },
    )
    .get(
        '/mail/:ownerId/message/:id/download',
        async ({ params, user, set }) => {
            requireSelf(params.ownerId, user.id);
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'message/rfc822';
            set.headers['Content-Transfer-Encoding'] = 'binary';
            set.headers['Content-Disposition'] = contentDisposition('attachment', `${params.id}.eml`);
            return await messageGetFile(user, params.id);
        },
        { auth: true },
    )
    .delete(
        '/mail/:ownerId/message/:id',
        async ({ params, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageDelete(user, params.id);
        },
        { auth: true },
    )
    .put(
        '/mail/:ownerId/message/move',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageMove(user, body.messageId, body.targetMailbox);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String(), targetMailbox: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/move-to-inbox',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageMoveToInbox(user, body.messageId);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/move-to-archive',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageMoveToArchive(user, body.messageId);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/move-to-spam',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageMoveToSpam(user, body.messageId);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/move-to-trash',
        async ({ params, body, user }) => {
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
            requireSelf(params.ownerId, user.id);
            return await messageCopy(user, body.messageId, body.targetMailbox);
        },
        {
            auth: true,
            body: t.Object({ messageId: t.String(), targetMailbox: t.String() }),
        },
    )
    .put(
        '/mail/:ownerId/message/draft',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageHandleDraft(user, body.mail);
        },
        {
            auth: true,
            body: t.Object({ mail: t.Any() }),
        },
    )
    .post(
        '/mail/:ownerId/message/send',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageSend(user, body.mail);
        },
        {
            auth: true,
            body: t.Object({ mail: t.Any() }),
        },
    )
    .put(
        '/mail/:ownerId/message/:id/read',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageSetRead(user, params.id, body.read);
        },
        {
            auth: true,
            body: t.Object({ read: t.Boolean() }),
        },
    )
    .put(
        '/mail/:ownerId/message/:id/flagged',
        async ({ params, body, user }) => {
            requireSelf(params.ownerId, user.id);
            return await messageSetFlagged(user, params.id, body.flagged);
        },
        {
            auth: true,
            body: t.Object({ flagged: t.Boolean() }),
        },
    )
    .get(
        '/mail/:ownerId/message/:id/attachment/:index/:fileName',
        async ({ params, user, set }) => {
            requireSelf(params.ownerId, user.id);
            set.headers['Cache-Control'] = 'public, max-age=86400';
            set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
            set.headers['Content-Type'] = 'application/octet-stream';
            set.headers['Content-Disposition'] = contentDisposition('attachment', params.fileName);
            const attachment = await messageGetAttachment(user, params.id, Number(params.index));
            return attachment?.content ?? null;
        },
        { auth: true },
    );
