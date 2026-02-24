import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EmailDetail, EmailDetailToolbar} from "../components/mail/email-detail";
import {EmailDraft, EmailDraftToolbar} from "../components/mail/email-draft";
import {
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
import {createDraftEmail} from "@workspace/lib/mail";
import {toast} from "sonner";
import {useEffect, useState} from 'react';
import {format} from "date-fns";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {ColumnLayout, Column} from "@workspace/ui/components/layout/column-layout";
import {useLayout} from "@workspace/ui/components/layout/layout-context";

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
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraft = useSendDraft();

    const [searchQuery, setSearchQuery] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteMail, setPendingDeleteMail] = useState<Email | null>(null);

    const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
    const {data: selectedEmail = null} = useEmail(mailId);
    const getEmailById = useEmailById();
    const {data: mailboxes = []} = useMailboxes();

    const selectedEmailInData = emails.find(m => m.id === selectedEmail?.id);
    if (selectedEmailInData) selectedEmailInData.isRead = true;

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
        if (mail.mailbox === 'trash') {
            setPendingDeleteMail(mail);
            setDeleteDialogOpen(true);
        } else {
            await deleteMail.mutateAsync(mail);
            navigateToList();
        }
    };

    const confirmDeleteEmail = async () => {
        if (pendingDeleteMail) {
            await deleteMail.mutateAsync(pendingDeleteMail);
            setDeleteDialogOpen(false);
            setPendingDeleteMail(null);
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
        if (email) handleDeleteEmail(email);
    };

    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        for (const id of emailIds) await handleDeleteEmailById(id);
    };

    const handleMoveEmailToFolderById = async (emailId: string, folderId: string) => {
        const email = await getEmailById(emailId);
        if (email) handleMoveEmail(email, folderId);
    };

    const handleMoveEmailsToFolderByIds = async (emailIds: string[], folderId: string) => {
        for (const id of emailIds) await handleMoveEmailToFolderById(id, folderId);
    };

    const handleArchiveEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) handleMoveEmail(email, 'archive');
    };

    const handleArchiveEmailsByIds = async (emailIds: string[]) => {
        for (const id of emailIds) await handleArchiveEmailById(id);
    };

    const handleReportSpamById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) handleMoveEmail(email, 'spam');
    };

    const handleReportSpamByIds = async (emailIds: string[]) => {
        for (const id of emailIds) await handleReportSpamById(id);
    };

    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) { toast.error("Could not load email"); return; }
        handleNewDraftEmail(createDraftEmail({
            to: email.from,
            subject: `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        }));
    };

    const handleReplyAllEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) { toast.error("Could not load email"); return; }
        const ccValues = Array.isArray(email.cc) ? email.cc.flatMap(c => c.value) : (email.cc?.value || []);
        handleNewDraftEmail(createDraftEmail({
            to: {value: [...(email.from?.value || []), ...ccValues], html: '', text: ''},
            subject: `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        }));
    };

    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) { toast.error("Could not load email"); return; }
        handleNewDraftEmail(createDraftEmail({
            subject: `FW: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        }));
    };

    useEffect(() => {
        if (mailId && mode) {
            navigate({
                to: `/_auth/${filterType}/${filterId}`,
                search: { mailId },
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
                    if (!open) setPendingDeleteMail(null);
                }}
                title="Delete Email"
                description="Are you sure you want to permanently delete this email"
                itemName={pendingDeleteMail?.subject || undefined}
                onDelete={confirmDeleteEmail}
            />
            <ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
                <Column id="list" width={listWidth} toolbar={listToolbar}>
                    <div className="flex flex-col border-r h-full overflow-hidden">
                        <EmailList
                            emails={emails}
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