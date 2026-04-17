import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { formatFullDateTime } from '@workspace/lib/date';
import {
    createDraftEmail,
    useDeleteEmail,
    useEmailById,
    useMoveEmail,
    useSendDraft,
    useToggleReadEmail,
    useUpdateDraft,
} from '@workspace/lib/mail';
import type { Email, NewDraft } from '@workspace/lib/types/mail';
import { Route } from '../../../routes/_auth.$filterType.$filterId';

export function useMailActions() {
    const { filterType, filterId } = Route.useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraftMutation = useSendDraft();
    const getEmailById = useEmailById();

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
            search: (prev) => ({ ...prev, mailId: emailId }),
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

    const handleNewDraftEmail = async (mail: NewDraft) => {
        const draft = await updateDraft.mutateAsync({ draft: mail });
        if (draft) {
            navigate({
                to: Route.fullPath,
                params: { filterType, filterId },
                search: { mailId: draft.id },
            });
        }
    };

    // After the first auto-save of a fresh compose, add ?mailId=... to the URL so a reload lands
    // back on the same draft. Keep mode='compose' so the composer session key stays stable and
    // the composer isn't remounted mid-typing.
    const handleDraftIdAssigned = (id: string) => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, mailId: id, mode: 'compose' }),
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

    const confirmDeleteEmails = async (pendingEmails: Email[]) => {
        if (pendingEmails.length > 0) {
            await Promise.allSettled(pendingEmails.map((mail) => deleteMail.mutateAsync(mail)));
            navigateToList();
        }
    };

    const handleDeleteEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) return handleDeleteEmail(email);
        return { needsConfirmation: false as const };
    };

    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        const trashEmails = emails.filter((e) => e.mailbox === 'Trash');
        const nonTrashEmails = emails.filter((e) => e.mailbox !== 'Trash');

        if (nonTrashEmails.length > 0) {
            await Promise.allSettled(nonTrashEmails.map((mail) => deleteMail.mutateAsync(mail)));
        }
        if (trashEmails.length > 0) {
            return { needsConfirmation: true as const, emails: trashEmails };
        }
        if (nonTrashEmails.length > 0) {
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
        await Promise.allSettled(emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: folderId })));
        navigateToList();
    };

    const handleArchiveEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, 'Archive');
    };

    const handleArchiveEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: 'Archive' })));
        navigateToList();
    };

    const handleReportSpamById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, 'Junk');
    };

    const handleReportSpamByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map((mail) => moveMail.mutateAsync({ email: mail, mailbox: 'Junk' })));
        navigateToList();
    };

    const escapeHtml = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        await handleNewDraftEmail(
            createDraftEmail({
                to: email.replyTo || email.from,
                subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
                html: formatEmailQuote(email),
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
        await handleNewDraftEmail(
            createDraftEmail({
                to: { value: allRecipients, html: '', text: '' },
                subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
                html: formatEmailQuote(email),
            }),
        );
    };

    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) return;
        await handleNewDraftEmail(
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
        handleDeleteEmail,
        confirmDeleteEmails,
        handleDeleteEmailById,
        handleDeleteEmailsByIds,
        handleMoveEmail,
        handleMoveEmailToFolderById,
        handleMoveEmailsToFolderByIds,
        handleArchiveEmailById,
        handleArchiveEmailsByIds,
        handleReportSpamById,
        handleReportSpamByIds,
        handleReplyEmail,
        handleReplyAllEmail,
        handleForwardEmail,
        handleSendEmail,
        handleNewDraftEmail,
        handleToggleMailRead,
        saveDraft: (
            draft: NewDraft,
            options: { tempAttachmentIds?: string[]; keepAttachmentIndexes?: number[] } = {},
        ) =>
            updateDraft.mutateAsync({
                draft,
                tempAttachmentIds: options.tempAttachmentIds,
                keepAttachmentIndexes: options.keepAttachmentIndexes,
            }),
        handleDraftIdAssigned,
        isSendPending: sendDraftMutation.isPending,
    };
}
