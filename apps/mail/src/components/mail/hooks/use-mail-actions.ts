import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { formatFullDateTime } from '@workspace/lib/date';
import { escapeHtml } from '@workspace/lib/html';
import {
    createDraftEmail,
    useDeleteEmail,
    useEmailById,
    useMoveEmail,
    useSendDraft,
    useToggleFlaggedEmail,
    useToggleReadEmail,
    useUpdateDraft,
} from '@workspace/lib/mail';
import type { DraftInput, Email, NewDraft } from '@workspace/lib/types/mail';
import { useRef } from 'react';
import { toast } from 'sonner';
import { Route } from '../../../routes/_auth.$filterType.$filterId';

// Single-slot undo (Gmail-style): only the most recent reversible action is remembered. `done` is a
// one-shot latch so the same action can't be reversed twice (e.g. `z` then clicking its still-visible toast).
type Undoable = { done?: boolean } & (
    | { kind: 'move'; items: { emailId: string; from: string }[]; to: string }
    | { kind: 'read'; items: { emailId: string; prevIsRead: boolean }[] }
    | { kind: 'flag'; items: { emailId: string; prevIsFlagged: boolean }[] }
);

export function useMailActions() {
    const { filterType, filterId } = Route.useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const toggleMailFlagged = useToggleFlaggedEmail();
    const updateDraft = useUpdateDraft();
    const sendDraftMutation = useSendDraft();
    const getEmailById = useEmailById();

    // Single-slot undo: overwritten by each new reversible action; `z` / the toast Undo reverses it.
    const lastAction = useRef<Undoable | null>(null);

    // Reverse a specific recorded action with the RAW mutations (never the recording helpers, or the
    // undo would record itself). The {...email, isRead/isFlagged: !prev} spread defeats each mutation's
    // own no-op guard so a genuine reversal always fires. Reverses the passed snapshot, not the slot —
    // so an old toast undoes the action it was shown for even after later actions overwrote the slot.
    const reverse = async (action: Undoable) => {
        if (action.done) return;
        action.done = true;
        if (action.kind === 'move') {
            for (const item of action.items) {
                const email = await getEmailById(item.emailId);
                if (email) moveMail.mutate({ email, mailbox: item.from });
            }
        } else if (action.kind === 'read') {
            for (const item of action.items) {
                const email = await getEmailById(item.emailId);
                if (email)
                    toggleMailRead.mutate({ email: { ...email, isRead: !item.prevIsRead }, isRead: item.prevIsRead });
            }
        } else {
            for (const item of action.items) {
                const email = await getEmailById(item.emailId);
                if (email)
                    toggleMailFlagged.mutate({
                        email: { ...email, isFlagged: !item.prevIsFlagged },
                        isFlagged: item.prevIsFlagged,
                    });
            }
        }
        toast.success('Undone');
    };

    // `z` key: reverse whatever is currently in the single slot. Consumes the slot up front; no-op
    // when empty. Keeps the "latest action" semantics.
    const undoLast = async () => {
        const action = lastAction.current;
        if (!action) return;
        lastAction.current = null;
        await reverse(action);
    };

    // Success toast with an Undo action, fired only for the destructive moves (archive/spam/delete).
    // Captures the exact `action` snapshot so the button reverses THAT, not the live slot. Clears the
    // slot only when it's still this same action, so `z` won't double-undo what the toast already did.
    const undoToast = (message: string, action: Undoable) => {
        toast.success(message, {
            action: {
                label: 'Undo',
                onClick: () => {
                    if (lastAction.current === action) lastAction.current = null;
                    void reverse(action);
                },
            },
        });
    };

    const navigateToList = () => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: {},
        });
    };

    const handleRowClick = (emailId: string) => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, mailId: emailId, mode: undefined, to: undefined }),
        });
    };

    // Fresh composeSessionKey remounts any open composer (see the session-key contract below).
    const openCompose = () => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: { mode: 'compose' },
            state: { composeSessionKey: crypto.randomUUID() },
        });
    };

    const handleMoveEmail = async (mail: Email, mailbox: string) => {
        await moveMail.mutateAsync({ email: mail, mailbox });
        navigateToList();
    };

    const handleSendEmail = async (mail: NewDraft) => {
        await sendDraftMutation.mutateAsync(mail);
        navigateToList();
    };

    // Navigate to the compose view with a prefilled draft in history state. No API call —
    // the composer reads the state at mount, seeds its fingerprint from it, and the first
    // POST only fires once the user actually edits (triggering the auto-save). The fresh
    // composeSessionKey remounts any composer that was already open (so clicking Reply
    // while typing a different message gives a clean composer with the new quoted body).
    const openPrefilledCompose = (prefillDraft: NewDraft) => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: { mode: 'compose' },
            state: { prefillDraft, composeSessionKey: crypto.randomUUID() },
        });
    };

    // After the first auto-save of a fresh compose, add ?mailId=... to the URL so a reload lands
    // back on the same draft. Keep mode='compose' and preserve history state so composeSessionKey
    // survives — otherwise the EmailDraft remount key would flip and nuke the in-progress typing.
    const handleDraftIdAssigned = (id: string) => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, mailId: id, mode: 'compose' }),
            state: true,
            replace: true,
        });
    };

    const handleDeleteEmail = async (mail: Email) => {
        if (mail.mailbox === 'Trash') {
            return { needsConfirmation: true as const, emails: [mail] };
        }
        await deleteMail.mutateAsync(mail);
        navigateToList();
        return { needsConfirmation: false as const };
    };

    // Permanent-delete fan-out: navigate on any success, and return the still-FAILED emails so the
    // route can narrow the retained set and keep the promise-aware DeleteDialog open on exactly those
    // (retry then re-hits only the failed ids, not the already-deleted ones). Each mutation reports its
    // own failure via onMutationError.
    const confirmDeleteEmails = async (pendingEmails: Email[]): Promise<Email[]> => {
        if (pendingEmails.length === 0) return [];
        const results = await Promise.allSettled(pendingEmails.map((mail) => deleteMail.mutateAsync(mail)));
        if (results.some((r) => r.status === 'fulfilled')) navigateToList();
        return pendingEmails.filter((_, i) => results[i].status === 'rejected');
    };

    // Fan-out batch: build the success toast, Undo slot and navigation from the FULFILLED results only.
    // Each mutation reports its own failure via onMutationError, so a partial failure must not claim the
    // full count nor offer to undo items that never moved; none-succeeded → no toast, no undo, no nav.
    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        const trashEmails = emails.filter((e) => e.mailbox === 'Trash');
        const nonTrashEmails = emails.filter((e) => e.mailbox !== 'Trash');

        let moved: Email[] = [];
        if (nonTrashEmails.length > 0) {
            const results = await Promise.allSettled(nonTrashEmails.map((mail) => deleteMail.mutateAsync(mail)));
            moved = nonTrashEmails.filter((_, i) => results[i].status === 'fulfilled');
            if (moved.length > 0) {
                const action: Undoable = {
                    kind: 'move',
                    items: moved.map((e) => ({ emailId: e.id, from: e.mailbox })),
                    to: 'Trash',
                };
                lastAction.current = action;
                undoToast(`${moved.length} moved to Trash`, action);
            }
        }
        if (trashEmails.length > 0) {
            return { needsConfirmation: true as const, emails: trashEmails };
        }
        if (moved.length > 0) {
            navigateToList();
        }
        return { needsConfirmation: false as const };
    };

    const handleMoveEmailToFolderById = async (emailId: string, folderId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, folderId);
    };

    const handleMoveEmailsToFolderByIds = async (emailIds: string[], folderId: string) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        const results = await Promise.allSettled(
            emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: folderId })),
        );
        if (results.some((r) => r.status === 'fulfilled')) navigateToList();
    };

    const handleArchiveEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        const results = await Promise.allSettled(
            emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: 'Archive' })),
        );
        const moved = emails.filter((_, i) => results[i].status === 'fulfilled');
        if (moved.length > 0) {
            const action: Undoable = {
                kind: 'move',
                items: moved.map((e) => ({ emailId: e.id, from: e.mailbox })),
                to: 'Archive',
            };
            lastAction.current = action;
            undoToast(`${moved.length} archived`, action);
            navigateToList();
        }
    };

    const handleReportSpamByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        const results = await Promise.allSettled(
            emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: 'Junk' })),
        );
        const moved = emails.filter((_, i) => results[i].status === 'fulfilled');
        if (moved.length > 0) {
            const action: Undoable = {
                kind: 'move',
                items: moved.map((e) => ({ emailId: e.id, from: e.mailbox })),
                to: 'Junk',
            };
            lastAction.current = action;
            undoToast(`${moved.length} reported as spam`, action);
            navigateToList();
        }
    };

    // Mutation-only variants (no navigateToList) for the open-conversation + cursored-row paths —
    // the route/shortcuts layer owns where to land after these.
    // Fire-and-forget (.mutate, not awaited mutateAsync): callers navigate/advance immediately and
    // must not block on the move/delete round-trip. Errors surface via the mutation's onMutationError.
    const moveEmailByIdOnly = async (emailId: string, mailbox: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        moveMail.mutate({ email, mailbox });
        const action: Undoable = { kind: 'move', items: [{ emailId, from: email.mailbox }], to: mailbox };
        lastAction.current = action;
        if (mailbox === 'Archive') undoToast('Archived', action);
        else if (mailbox === 'Junk') undoToast('Reported as spam', action);
    };

    const deleteEmailByIdOnly = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return { needsConfirmation: false as const };
        if (email.mailbox === 'Trash') return { needsConfirmation: true as const, emails: [email] };
        deleteMail.mutate(email);
        const action: Undoable = { kind: 'move', items: [{ emailId, from: email.mailbox }], to: 'Trash' };
        lastAction.current = action;
        undoToast('Moved to Trash', action);
        return { needsConfirmation: false as const };
    };

    // currentIsRead/currentFlagged come from the fresh list summary. The detail from getEmailById can
    // carry a stale flag (staleTime:Infinity), which would make the mutation's own no-op guard
    // (isRead === email.isRead) skip a real change — so pre-guard on the fresh value AND overwrite the
    // detail's field with it before handing off, keeping both guards consistent.
    const setReadById = async (emailId: string, isRead: boolean, currentIsRead: boolean) => {
        if (currentIsRead === isRead) return;
        const email = await getEmailById(emailId);
        if (!email) return;
        toggleMailRead.mutate({ email: { ...email, isRead: currentIsRead }, isRead });
        lastAction.current = { kind: 'read', items: [{ emailId, prevIsRead: currentIsRead }] };
    };

    const setFlaggedById = async (emailId: string, flagged: boolean, currentFlagged: boolean) => {
        if (currentFlagged === flagged) return;
        const email = await getEmailById(emailId);
        if (!email) return;
        toggleMailFlagged.mutate({ email: { ...email, isFlagged: currentFlagged }, isFlagged: flagged });
        lastAction.current = { kind: 'flag', items: [{ emailId, prevIsFlagged: currentFlagged }] };
    };

    // Batch read/flag: fire each mutation, then record ONE Undoable holding every changed item so `z`
    // reverts all N (a per-item loop would leave the slot holding only the last). Skips items already
    // at the target — same pre-guard as the single-id versions.
    const setReadByIds = async (items: { id: string; currentIsRead: boolean }[], isRead: boolean) => {
        const undoItems: { emailId: string; prevIsRead: boolean }[] = [];
        for (const it of items) {
            if (it.currentIsRead === isRead) continue;
            const email = await getEmailById(it.id);
            if (!email) continue;
            toggleMailRead.mutate({ email: { ...email, isRead: it.currentIsRead }, isRead });
            undoItems.push({ emailId: it.id, prevIsRead: it.currentIsRead });
        }
        if (undoItems.length > 0) lastAction.current = { kind: 'read', items: undoItems };
    };

    const setFlaggedByIds = async (items: { id: string; currentFlagged: boolean }[], flagged: boolean) => {
        const undoItems: { emailId: string; prevIsFlagged: boolean }[] = [];
        for (const it of items) {
            if (it.currentFlagged === flagged) continue;
            const email = await getEmailById(it.id);
            if (!email) continue;
            toggleMailFlagged.mutate({ email: { ...email, isFlagged: it.currentFlagged }, isFlagged: flagged });
            undoItems.push({ emailId: it.id, prevIsFlagged: it.currentFlagged });
        }
        if (undoItems.length > 0) lastAction.current = { kind: 'flag', items: undoItems };
    };

    const formatEmailQuote = (email: Email) => {
        const fromName = escapeHtml(email.from?.value[0]?.name || '');
        const fromAddress = escapeHtml(email.from?.value[0]?.address || '');
        const dateText = escapeHtml(formatFullDateTime(new Date(email.date)));
        const header = `On ${dateText} ${fromName} &lt;${fromAddress}&gt; wrote:`;
        // email.html is already sanitized by the backend via isomorphic-dompurify in mail-parse.ts,
        // and email.text is plain text (not HTML) so it's safe to embed as-is in a blockquote.
        const content = email.html || (email.text ? escapeHtml(email.text).replace(/\n/g, '<br>') : '');
        return `<br><br><p>${header}</p><blockquote>${content}</blockquote>`;
    };

    // Seed RFC 5322 threading from the message being replied to: In-Reply-To points at its
    // Message-ID, References appends it to whatever chain it already carried. Skipped when the
    // original has no Message-ID (nothing to thread against).
    const replyThreadingHeaders = (email: Email): Pick<DraftInput, 'inReplyTo' | 'references'> => {
        if (!email.messageId) return {};
        const prior = email.references ? (Array.isArray(email.references) ? email.references : [email.references]) : [];
        return { inReplyTo: email.messageId, references: [...prior, email.messageId] };
    };

    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        openPrefilledCompose(
            createDraftEmail({
                to: email.replyTo || email.from,
                subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
                html: formatEmailQuote(email),
                ...replyThreadingHeaders(email),
            }),
        );
    };

    const handleReplyAllEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        const myEmail = user?.email?.toLowerCase();
        const toValues = Array.isArray(email.to) ? email.to.flatMap((t) => t.value) : email.to?.value || [];
        const ccValues = Array.isArray(email.cc) ? email.cc.flatMap((c) => c.value) : email.cc?.value || [];
        const replyTo = (email.replyTo || email.from)?.value || [];
        const allRecipients = [...replyTo, ...toValues, ...ccValues].filter(
            (addr) => addr.address?.toLowerCase() !== myEmail,
        );
        openPrefilledCompose(
            createDraftEmail({
                to: { value: allRecipients, html: '', text: '' },
                subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
                html: formatEmailQuote(email),
                ...replyThreadingHeaders(email),
            }),
        );
    };

    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        openPrefilledCompose(
            createDraftEmail({
                subject: `FW: ${email.subject}`,
                html: formatEmailQuote(email),
            }),
        );
    };

    const handleToggleMailRead = (email: Email, isRead: boolean) => {
        toggleMailRead.mutate({ email, isRead });
    };

    return {
        navigateToList,
        handleRowClick,
        openCompose,
        handleDeleteEmail,
        confirmDeleteEmails,
        handleDeleteEmailsByIds,
        handleMoveEmail,
        handleMoveEmailToFolderById,
        handleMoveEmailsToFolderByIds,
        handleArchiveEmailsByIds,
        handleReportSpamByIds,
        moveEmailByIdOnly,
        deleteEmailByIdOnly,
        setReadById,
        setFlaggedById,
        setReadByIds,
        setFlaggedByIds,
        undoLast,
        handleReplyEmail,
        handleReplyAllEmail,
        handleForwardEmail,
        handleSendEmail,
        handleToggleMailRead,
        saveDraft: (
            draft: NewDraft,
            options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[]; forceFullSave?: boolean } = {},
        ) =>
            updateDraft.mutateAsync({
                draft,
                tempAttachmentIds: options.tempAttachmentIds,
                keepAttachmentIndexes: options.keepAttachmentIndexes,
                forceFullSave: options.forceFullSave,
            }),
        handleDraftIdAssigned,
        isSendPending: sendDraftMutation.isPending,
    };
}
