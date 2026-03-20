import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EmailDetail, EmailDetailToolbar} from "../components/mail/email-detail";
import {EmailDraft, EmailDraftToolbar} from "../components/mail/email-draft";
import {
    createDraftEmail,
    useDeleteEmail,
    useEmail,
    useEmailById,
    useEmails,
    useMailboxes,
    useMoveEmail,
    useSendDraft,
    useToggleReadEmail,
    useUpdateDraft
} from '@workspace/lib/mail';
import {EmailList, EmailListToolbar} from "../components/mail/email-list";
import {Email, EmailDraft as EmailDraftType} from "@workspace/lib/types/mail";
import {toast} from "sonner";
import {useEffect, useState} from 'react';
import {format} from "date-fns";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {Column, ColumnLayout} from "@workspace/ui/components/layout/app/column-layout.tsx";
import {useLayout} from "@workspace/ui/components/layout/app/layout-context.tsx";
import {useAuth} from "@workspace/lib/auth";

export type MailSearchParams = {
    mailId?: string;
    mode?: string;
    to?: string;
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
        const to = typeof search.to === 'string' ? search.to.toLowerCase() : undefined;
        const mode = (!mailId && typeof search.mode === 'string') ? search.mode : undefined;

        return {mailId, mode, to} as MailSearchParams;
    },
});

function MailRoute() {
    const {filterType, filterId} = Route.useParams();
    const {mailId, mode, to} = Route.useSearch();
    const navigate = useNavigate();
    const {isTablet} = useLayout();
    const {user} = useAuth();
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraft = useSendDraft();

    const [searchQuery, setSearchQuery] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteEmails, setPendingDeleteEmails] = useState<Email[]>([]);

    const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
    const {data: selectedEmail = null} = useEmail(mailId);
    const getEmailById = useEmailById();
    const {data: mailboxes = []} = useMailboxes();

    const selectedEmailInData = emails.find(m => m.id === selectedEmail?.id);
    const displayEmails = selectedEmailInData
        ? emails.map(m => m.id === selectedEmail?.id ? {...m, isRead: true} : m)
        : emails;

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

    const handleDeleteEmail = async (mail: Email) => {
        if (mail.mailbox === 'Trash') {
            setPendingDeleteEmails([mail]);
            setDeleteDialogOpen(true);
        } else {
            await deleteMail.mutateAsync(mail);
            navigateToList();
        }
    };

    const confirmDeleteEmails = async () => {
        if (pendingDeleteEmails.length > 0) {
            await Promise.allSettled(pendingDeleteEmails.map(mail => deleteMail.mutateAsync(mail)));
            setDeleteDialogOpen(false);
            setPendingDeleteEmails([]);
            navigateToList();
        }
    };

    const handleMoveEmail = async (mail: Email, mailbox: string) => {
        await moveMail.mutateAsync({email: mail, mailbox});
        navigateToList();
    };

    const handleSendEmail = async (mail: EmailDraftType) => {
        await sendDraft.mutateAsync(mail);
        navigateToList();
    };

    const handleNewDraftEmail = async (mail: EmailDraftType) => {
        const draft = await updateDraft.mutateAsync(mail);
        if (draft) {
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {mailId: draft.id},
            });
        }
    };

    const handleDeleteEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) await handleDeleteEmail(email);
    };

    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        const emails = (await Promise.all(emailIds.map(id => getEmailById(id)))).filter((e): e is Email => !!e);
        const trashEmails = emails.filter(e => e.mailbox === 'Trash');
        const nonTrashEmails = emails.filter(e => e.mailbox !== 'Trash');

        if (nonTrashEmails.length > 0) {
            await Promise.allSettled(nonTrashEmails.map(mail => deleteMail.mutateAsync(mail)));
        }
        if (trashEmails.length > 0) {
            setPendingDeleteEmails(trashEmails);
            setDeleteDialogOpen(true);
        }
        if (nonTrashEmails.length > 0 && trashEmails.length === 0) {
            navigateToList();
        }
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

    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }
        handleNewDraftEmail(createDraftEmail({
            to: email.replyTo || email.from,
            subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
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
        handleNewDraftEmail(createDraftEmail({
            to: {value: allRecipients, html: '', text: ''},
            subject: email.subject?.startsWith('RE:') ? email.subject : `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        }));
    };

    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }
        handleNewDraftEmail(createDraftEmail({
            subject: `FW: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        }));
    };

    useEffect(() => {
        if (mailId && mode) {
            navigate({
                to: `/_auth/${filterType}/${filterId}`,
                search: {mailId},
                replace: true,
            });
        }
    }, [mailId, mode, navigate, filterType, filterId]);

    const listWidth = isTablet ? '320px' : '400px';
    const showDetail = !!(selectedEmail || mode === "compose");
    const isDraft = mode === "compose" || selectedEmail?.isDraft;

    const listToolbar = (
        <EmailListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
        />
    );

    const detailToolbar = isDraft ? (
        <EmailDraftToolbar
            onSend={() => handleSendEmail(selectedEmail as EmailDraftType)}
            onDelete={() => handleDeleteEmail(selectedEmail as EmailDraftType)}
            isSending={sendDraft.isPending}
            hasId={!!selectedEmail?.id}
        />
    ) : selectedEmail ? (
        <EmailDetailToolbar
            email={selectedEmail}
            onDelete={handleDeleteEmailById}
            onArchive={handleArchiveEmailById}
            onReportSpam={handleReportSpamById}
            onMoveToFolder={handleMoveEmailToFolderById}
            onReply={handleReplyEmail}
            onReplyAll={handleReplyAllEmail}
            onForward={handleForwardEmail}
            mailboxes={mailboxes}
        />
    ) : null;

    return (
        <>
            <DeleteDialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                    setDeleteDialogOpen(open);
                    if (!open) setPendingDeleteEmails([]);
                }}
                title={pendingDeleteEmails.length === 1 ? "Delete Email" : `Delete ${pendingDeleteEmails.length} Emails`}
                description={pendingDeleteEmails.length === 1
                    ? "Are you sure you want to permanently delete this email"
                    : `Are you sure you want to permanently delete ${pendingDeleteEmails.length} emails`}
                itemName={pendingDeleteEmails.length === 1 ? pendingDeleteEmails[0]?.subject || undefined : undefined}
                onDelete={confirmDeleteEmails}
            />
            <ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
                <Column id="list" width={listWidth} toolbar={listToolbar}>
                    <div className="flex flex-col border-r h-full overflow-hidden">
                        <EmailList
                            emails={displayEmails}
                            searchQuery={searchQuery}
                            isLoading={isEmailsLoading}
                            error={isEmailsError}
                            onRowClick={handleRowClick}
                            activeRowId={mailId}
                            mailboxes={mailboxes}
                            onDelete={handleDeleteEmailsByIds}
                            onArchive={handleArchiveEmailsByIds}
                            onReportSpam={handleReportSpamByIds}
                            onMoveToFolder={handleMoveEmailsToFolderByIds}
                            onReply={handleReplyEmail}
                            onReplyAll={handleReplyAllEmail}
                            onForward={handleForwardEmail}
                        />
                    </div>
                </Column>
                <Column id="detail" width="flex" onBack={isDraft ? undefined : navigateToList} toolbar={detailToolbar}>
                    {showDetail ? (
                        isDraft ? (
                            <EmailDraft
                                email={selectedEmail as EmailDraftType}
                                onDelete={handleDeleteEmail}
                                sendDraft={handleSendEmail}
                                to={to}
                            />
                        ) : (
                            <EmailDetail
                                email={selectedEmail}
                                toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}
                            />
                        )
                    ) : (
                        <div className="h-full w-full flex items-center justify-center">
                            <p className="text-muted-foreground">Select an email to view details</p>
                        </div>
                    )}
                </Column>
            </ColumnLayout>
        </>
    );
}