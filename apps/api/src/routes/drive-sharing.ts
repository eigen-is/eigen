// The Drive HTTP routes about who may use a path and what happens to it: its ACL, its members, the
// caller's permissions, mail to its collaborators, access requests, its history and its watchers. Each
// gets its drive from getSharedDrive, which checks the access, except an access request, which comes
// from someone who has none yet. Guests can't share, so the sharing routes refuse them.

import { MAX_SEND_RECIPIENTS } from '@workspace/lib/constants/mail';
import type {
    DriveAccessCheckResult,
    DrivePathPermissions,
    DriveVisibility,
    EffectiveMember,
} from '@workspace/lib/types/drive-access';
import type { ClientFileEventInput, FileEvent, PathWatchStatus } from '@workspace/lib/types/file-history';
import { CARD_TITLE_MAX_LENGTH } from '@workspace/lib/types/file-history';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import type { Static } from 'elysia';
import { Elysia, t } from 'elysia';
import { requireNonGuest } from '../lib/auth/access';
import { getSharedDrive } from '../lib/drive';
import { propagateAccessRequest } from '../lib/drive/access-request-propagation';
import { betterAuth } from './auth';
import type { TypesEqual } from './shared-schemas';

// The longest free-text note a share route takes, such as a mail to the collaborators or an access
// request. A longer note is never stored or mailed.
const MAX_SHARE_MESSAGE_LENGTH = 12000;

// One object per event type, so the identity guard below can hold it against ClientFileEventInput.
const CARD_TEXT = { maxLength: CARD_TITLE_MAX_LENGTH };
const stickyCardDetails = t.Object({
    card: t.String(CARD_TEXT),
    toColumn: t.String(CARD_TEXT),
    cardId: t.String(CARD_TEXT),
});
const clientFileEventBody = t.Union([
    t.Object({ eventType: t.Literal('sticky-added'), details: stickyCardDetails }),
    t.Object({ eventType: t.Literal('sticky-moved'), details: stickyCardDetails }),
    t.Object({
        eventType: t.Literal('sticky-removed'),
        details: t.Object({ card: t.String(CARD_TEXT), cardId: t.String(CARD_TEXT) }),
    }),
]);
const _clientFileEventBodyMatchesType: TypesEqual<Static<typeof clientFileEventBody>, ClientFileEventInput> = true;
void _clientFileEventBodyMatchesType;

const visibilitySchema = t.Union([t.Literal('private'), t.Literal('public-read'), t.Literal('public-write')]);
const _visibilitySchemaMatchesType: TypesEqual<Static<typeof visibilitySchema>, DriveVisibility> = true;
void _visibilitySchemaMatchesType;

export const driveSharingRouter = new Elysia({ name: 'drive-sharing' })
    .use(betterAuth)
    .put(
        '/drive/:ownerId/:mountId/path/:pathId/acl',
        async ({ params, body, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            // The server merges the change onto the ACL as it is now, so two people sharing at once can't undo each
            // other. On another owner's drive SharedDrive ignores the user and uses its own.
            await drive.updateACLDelta(
                params.mountId,
                params.pathId,
                { add: body.add, remove: body.remove },
                body.visibility,
                body.sharingRestricted,
                user,
            );
            return { success: true };
        },
        {
            body: t.Object({
                add: t.Optional(
                    t.Array(
                        t.Object({
                            id: t.String({ maxLength: MAX_EMAIL_LENGTH }),
                            read: t.Boolean(),
                            write: t.Boolean(),
                        }),
                        { maxItems: MAX_SEND_RECIPIENTS },
                    ),
                ),
                remove: t.Optional(t.Array(t.String())),
                visibility: t.Optional(visibilitySchema),
                sharingRestricted: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/effective-members',
        async ({ params, user }): Promise<EffectiveMember[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.getEffectiveMembers(params.mountId, params.pathId);
        },
        { auth: true },
    )
    // Tells the dialog that mails a link which addresses can already read the path. Guests can't share,
    // so they get no answer. The sender's own address is left out, so only recipients are checked.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/access-check',
        async ({ params, body, user }): Promise<DriveAccessCheckResult> => {
            requireNonGuest(user);
            const self = user.email.toLowerCase();
            const emails = body.emails.filter((email) => email.toLowerCase() !== self);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.checkAccessForEmails(params.mountId, params.pathId, emails);
        },
        {
            body: t.Object({
                emails: t.Array(t.String({ maxLength: MAX_EMAIL_LENGTH }), { maxItems: MAX_SEND_RECIPIENTS }),
            }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/email-collaborators',
        async ({ params, body, user }): Promise<{ sent: number }> => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.emailCollaborators(
                params.mountId,
                params.pathId,
                body.subject ?? null,
                body.message,
                body.sendCopyToSelf,
                user,
            );
        },
        {
            body: t.Object({
                subject: t.Optional(t.String({ maxLength: 200 })),
                message: t.String({ maxLength: MAX_SHARE_MESSAGE_LENGTH }),
                sendCopyToSelf: t.Boolean(),
            }),
            auth: true,
        },
    )
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/request-access',
        async ({ params, user, body }): Promise<{ success: boolean }> => {
            // A guest can't be given a share, so there is nothing to request.
            requireNonGuest(user);
            // This skips SharedDrive on purpose, since the caller has no access yet. propagateAccessRequest only
            // notifies the owner through the home relay and never reads the path for the requester.
            await propagateAccessRequest(params.ownerId, params.mountId, params.pathId, user, body.message ?? null);
            return { success: true };
        },
        {
            auth: true,
            body: t.Object({
                message: t.Optional(t.String({ maxLength: MAX_SHARE_MESSAGE_LENGTH })),
            }),
        },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/permissions',
        async ({ params, user }): Promise<DrivePathPermissions> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const [canRead, canWrite] = await Promise.all([
                drive.canRead(params.mountId, params.pathId, user),
                drive.canWrite(params.mountId, params.pathId, user),
            ]);
            return { canRead, canWrite };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/history',
        async ({ params, query, user }): Promise<FileEvent[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.getFileHistory(params.mountId, params.pathId, { limit: query.limit });
        },
        { auth: true, query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })) }) },
    )
    // History events that a client sends. The body's union lists the event types that a client may
    // post. Every other type is written by the server only.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/history',
        async ({ params, body, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.recordClientFileEvent(params.mountId, params.pathId, user, body);
            return { success: true };
        },
        {
            auth: true,
            body: clientFileEventBody,
        },
    )
    // Watching a file or a folder. A folder's watch covers everything under it.
    .post(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }): Promise<{ success: boolean }> => {
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.watchPath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .delete(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }): Promise<{ success: boolean }> => {
            const drive = await getSharedDrive(params.ownerId, user);
            await drive.unwatchPath(params.mountId, params.pathId, user);
            return { success: true };
        },
        { auth: true },
    )
    .get(
        '/drive/:ownerId/:mountId/path/:pathId/watch',
        async ({ params, user }): Promise<PathWatchStatus> => {
            const drive = await getSharedDrive(params.ownerId, user);
            return drive.getWatchStatus(params.mountId, params.pathId, user);
        },
        { auth: true },
    );
