import {useNavigate} from '@tanstack/react-router';
import {
    createDraftEmail,
    useDeleteEmail,
    useEmailById,
    useMoveEmail,
    useSendDraft,
    useToggleReadEmail,
    useUpdateDraft
} from '@workspace/lib/mail';
import type {Email, EmailDraft} from '@workspace/lib/types/mail';
import {toast} from 'sonner';
import {format} from 'date-fns';
import {useAuth} from '@workspace/lib/auth';
import {Route} from '../../../routes/_auth.$filterType.$filterId';

export function useMailActions() {
    const {filterType, filterId} = Route.useParams();
    const navigate = useNavigate();
    const {user} = useAuth();
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraftMutation = useSendDraft();
    const getEmailById = useEmailById();

    const navigateToList = () => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    };

    const handleRowClick = (emailId: string) => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: (prev) => ({...prev, mailId: emailId}),
        });
    };

    const handleMoveEmail = async (mail: Email, mailbox: string) => {
        await moveMail.mutateAsync({email: mail, mailbox});
        navigateToList();
    };

    const handleSendEmail = async (mail: EmailDraft) => {
        await sendDraftMutation.mutateAsync(mail);
        navigateToList();
    };

    const handleNewDraftEmail = async (mail: EmailDraft) => {
        const draft = await updateDraft.mutateAsync(mail);
        if (draft) {
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {mailId: draft.id},
            });
        }
    };

    const handleDeleteEmail = async (mail: Email) => {
        if (mail.mailbox === 'Trash') {
            return {needsConfirmation: true as const, emails: [mail]};
        }
        await deleteMail.mutateAsync(mail);
        navigateToList();
        return {needsConfirmation: false as const};
    };

    const confirmDeleteEmails = async (pendingEmails: Email[]) => {
        if (pendingEmails.length > 0) {
            await Promise.allSettled(pendingEmails.map(mail => deleteMail.mutateAsync(mail)));
            navigateToList();
        }
    };

    const handleDeleteEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) return handleDeleteEmail(email);
        return {needsConfirmation: false as const};
    };

    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map(id => getEmailById(id)))).filter((e): e is Email => !!e);
        const trashEmails = emails.filter(e => e.mailbox === 'Trash');
        const nonTrashEmails = emails.filter(e => e.mailbox !== 'Trash');

        if (nonTrashEmails.length > 0) {
            await Promise.allSettled(nonTrashEmails.map(mail => deleteMail.mutateAsync(mail)));
        }
        if (trashEmails.length > 0) {
            return {needsConfirmation: true as const, emails: trashEmails};
        }
        if (nonTrashEmails.length > 0) {
            navigateToList();
        }
        return {needsConfirmation: false as const};
    };

    const handleMoveEmailToFolderById = async (emailId: string, folderId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, folderId);
    };

    const handleMoveEmailsToFolderByIds = async (emailIds: string[], folderId: string) => {
        const emails = (await Promise.all(emailIds.map(id => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map(mail => moveMail.mutateAsync({email: mail, mailbox: folderId})));
        navigateToList();
    };

    const handleArchiveEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, 'Archive');
    };

    const handleArchiveEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map(id => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map(mail => moveMail.mutateAsync({email: mail, mailbox: 'Archive'})));
        navigateToList();
    };

    const handleReportSpamById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleMoveEmail(email, 'Junk');
    };

    const handleReportSpamByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map(id => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map(mail => moveMail.mutateAsync({email: mail, mailbox: 'Junk'})));
        navigateToList();
    };

    const formatEmailQuote = (email: Email) => {
        return `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`;
    };

    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }
        await handleNewDraftEmail(createDraftEmail({
            to: email.replyTo || email.from,
            subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
            text: formatEmailQuote(email),
        }));
    };

    const handleReplyAllEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }
        const myEmail = user?.email?.toLowerCase();
        const toValues = Array.isArray(email.to) ? email.to.flatMap(t => t.value) : (email.to?.value || []);
        const ccValues = Array.isArray(email.cc) ? email.cc.flatMap(c => c.value) : (email.cc?.value || []);
        const replyTo = (email.replyTo || email.from)?.value || [];
        const allRecipients = [...replyTo, ...toValues, ...ccValues]
            .filter(addr => addr.address?.toLowerCase() !== myEmail);
        await handleNewDraftEmail(createDraftEmail({
            to: {value: allRecipients, html: '', text: ''},
            subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
            text: formatEmailQuote(email),
        }));
    };

    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }
        await handleNewDraftEmail(createDraftEmail({
            subject: `FW: ${email.subject}`,
            text: formatEmailQuote(email),
        }));
    };

    const handleToggleMailRead = (email: Email, isRead: boolean) => {
        toggleMailRead.mutate({email, isRead});
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
        saveDraft: updateDraft.mutateAsync,
        isSendPending: sendDraftMutation.isPending,
    };
}
