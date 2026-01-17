import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EmailDetail} from "../components/mail/email-detail.tsx";
import {EmailDraft} from "../components/mail/email-draft.tsx";
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
import {EmailList} from "@/components/mail/email-list.tsx";
import {Email, EmailDraft as EmailDraftType} from "@workspace/lib/types/mail";
import {toast} from "sonner";
import {useEffect, useState} from 'react';
import {useIsMobile, useIsTablet} from "@workspace/lib/media";
import {format} from "date-fns";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";

// Define search params type
export interface MailSearchParams {
    mailId?: string;
    mode?: string;
    to?: string;
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
        const to = typeof search.to === 'string' ? search.to.toLowerCase() : undefined;
        // Only set mode if mailId is not present
        const mode = (!mailId && typeof search.mode === 'string') ? search.mode : undefined;

        return {mailId, mode, to} as MailSearchParams;
    },
});

function MailRoute() {
    const {filterType, filterId} = Route.useParams();
    const {mailId, mode, to} = Route.useSearch();
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const deleteMail = useDeleteEmail();
    const moveMail = useMoveEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraft = useSendDraft();

    const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
    const {data: selectedEmail = null} = useEmail(mailId);
    const getEmailById = useEmailById();
    const {data: mailboxes = [], isLoading: isMailboxesLoading, error: isMailboxesError} = useMailboxes();

    const selectedEmailInData = emails.find(m => m.id === selectedEmail?.id);
    if (selectedEmailInData) selectedEmailInData.isRead = true;

    // Handler for replying to an email
    const handleReplyEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }

        // Create a reply draft using the existing handleNewDraftEmail function
        const draft: EmailDraftType = {
            to: email.from,
            subject: `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        };

        handleNewDraftEmail(draft);
    };

    // Handler for replying to all recipients
    const handleReplyAllEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }

        // Create a reply-all draft
        const draft: EmailDraftType = {
            to: {value: [...(email.from?.value || []), ...(email.cc?.value || [])]},
            subject: `RE: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        };

        handleNewDraftEmail(draft);
    };

    // Handler for forwarding an email
    const handleForwardEmail = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (!email) {
            toast.error("Could not load email");
            return;
        }

        // Create a forward draft
        const draft: EmailDraftType = {
            subject: `FW: ${email.subject}`,
            text: `\n\nOn ${format(new Date(email.date), "d MMM yyyy 'at' h:mm a")} ${email.from?.value[0]?.name} <${email.from?.value[0]?.address}> wrote:\n\n${email.text}`,
        };

        handleNewDraftEmail(draft);
    };

    // Wrapper functions for the EmailList component that work with email IDs
    const handleDeleteEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) {
            handleDeleteEmail(email);
        }
    };

    const handleMoveEmailById = (mailbox: string) => async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) {
            handleMoveEmail(email, mailbox);
        }
    };

    const handleMoveEmailToFolderById = async (emailId: string, folderId: string) => {
        const email = await getEmailById(emailId);
        if (email) {
            handleMoveEmail(email, folderId);
        }
    };

    const handleArchiveEmailById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) {
            handleMoveEmail(email, 'archive');
        }
    };

    const handleReportSpamById = async (emailId: string) => {
        const email = await getEmailById(emailId);
        if (email) {
            handleMoveEmail(email, 'spam');
        }
    };

    // Handle row click to show email details
    const handleRowClick = (emailId: string) => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: (prev) => ({...prev, mailId: emailId}),
        });
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    };

    // State for DeleteDialog
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteMail, setPendingDeleteMail] = useState<Email | null>(null);

    const handleDeleteEmail = async (mail: Email) => {
        if (mail.mailbox === 'trash') {
            setPendingDeleteMail(mail);
            setDeleteDialogOpen(true);
        } else {
            await deleteMail.mutateAsync(mail);
            toast("Email deleted");
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
        }
    };

    const confirmDeleteEmail = async () => {
        if (pendingDeleteMail) {
            await deleteMail.mutateAsync(pendingDeleteMail);
            toast("Email deleted");
            setDeleteDialogOpen(false);
            setPendingDeleteMail(null);
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
        }
    };

    const handleSendEmail = async (mail: EmailDraftType) => {
        await sendDraft.mutateAsync(mail);
        toast.success("Email sent");
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    }

    const handleMoveEmail = async (mail: Email, mailbox: string) => {
        await moveMail.mutateAsync({email: mail, mailbox});
        toast(`Email moved to ${mailbox}`);
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    }

    const handleNewDraftEmail = async (mail: EmailDraftType) => {
        const draft = await updateDraft.mutateAsync(mail);
        if (draft) {
            toast("Email draft updated");
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {mailId: draft.id},
            });
        }
    }

    // Ensure that if mailId is set, mode is removed from URL
    useEffect(() => {
        if (mailId && mode) {
            // Navigate to the same route but without the mode parameter
            navigate({
                to: `/_auth/${filterType}/${filterId}`,
                search: {
                    mailId
                },
                replace: true // Replace the current history entry
            });
        }
    }, [mailId, mode, navigate, filterType, filterId]);

    // On mobile: Show full-width email list / detail
    if (isMobile) {
        return (
            <div className="flex-1 h-full w-full">
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
                {selectedEmail || mode === "compose" ? (
                    <div className="flex-1 h-full w-full">
                        {mode === "compose" || selectedEmail?.isDraft ? (
                            <EmailDraft
                                email={selectedEmail as EmailDraftType}
                                isMobile={true}
                                onBackClick={handleBackToList}
                                onDelete={handleDeleteEmail}
                                toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}
                                sendDraft={handleSendEmail}
                                to={to}
                                updateDraft={updateDraft.mutateAsync}
                            />
                        ) : (
                            <EmailDetail
                                email={selectedEmail}
                                isMobile={true}
                                onBackClick={handleBackToList}
                                toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}
                                onDelete={handleDeleteEmailById}
                                onArchive={handleArchiveEmailById}
                                onReportSpam={handleReportSpamById}
                                onMoveToFolder={handleMoveEmailToFolderById}
                                onReply={handleReplyEmail}
                                onReplyAll={handleReplyAllEmail}
                                onForward={handleForwardEmail}
                                mailboxes={mailboxes}
                            />
                        )}
                    </div>
                ) : (
                    <div className="flex-1 h-full w-full">
                        <EmailList
                            emails={emails}
                            isLoading={isEmailsLoading}
                            error={isEmailsError}
                            onRowClick={handleRowClick}
                            activeRowId={mailId}
                            mailboxes={mailboxes}
                            onDelete={handleDeleteEmailById}
                            onArchive={handleArchiveEmailById}
                            onReportSpam={handleReportSpamById}
                            onMoveToFolder={handleMoveEmailToFolderById}
                            onReply={handleReplyEmail}
                            onReplyAll={handleReplyAllEmail}
                            onForward={handleForwardEmail}
                        />
                    </div>
                )}
            </div>
        );
    }

    // Calculate list width based on device type
    const getListWidthClass = () => {
        if (isTablet) {
            return "w-[320px]"; // Narrower on tablet for more space for content
        } else {
            return "w-[400px]"; // Default on desktop
        }
    };

    // Desktop/Tablet: Two-column layout (sidebar already handled in _auth.tsx)
    return (
        <div className="flex h-full w-full">
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
            {/* Email list column */}
            <div className={`
        flex flex-col ${getListWidthClass()} border-r h-full overflow-hidden
      `}>
                <EmailList
                    emails={emails}
                    isLoading={isEmailsLoading}
                    error={isEmailsError}
                    onRowClick={handleRowClick}
                    activeRowId={mailId}
                    mailboxes={mailboxes}
                    onDelete={handleDeleteEmailById}
                    onArchive={handleArchiveEmailById}
                    onReportSpam={handleReportSpamById}
                    onMoveToFolder={handleMoveEmailToFolderById}
                    onReply={handleReplyEmail}
                    onReplyAll={handleReplyAllEmail}
                    onForward={handleForwardEmail}
                />
            </div>

            {/* Email details column */}
            <div className="flex-1 h-full overflow-hidden">
                {selectedEmail || mode === "compose" ? (
                    <div className="h-full">
                        {mode === "compose" || selectedEmail?.isDraft ? (
                            <EmailDraft
                                email={selectedEmail as EmailDraftType}
                                className="border-none h-full"
                                onDelete={handleDeleteEmail}
                                toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}
                                sendDraft={handleSendEmail}
                                to={to}
                                updateDraft={updateDraft.mutateAsync}
                            />
                        ) : (
                            <EmailDetail
                                email={selectedEmail}
                                className="border-none h-full"
                                toggleMailRead={(email, isRead) => toggleMailRead.mutate({email, isRead})}
                                onDelete={handleDeleteEmailById}
                                onArchive={handleArchiveEmailById}
                                onReportSpam={handleReportSpamById}
                                onMoveToFolder={handleMoveEmailToFolderById}
                                onReply={handleReplyEmail}
                                onReplyAll={handleReplyAllEmail}
                                onForward={handleForwardEmail}
                                mailboxes={mailboxes}
                            />
                        )}
                    </div>
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select an email to view details</p>
                    </div>
                )}
            </div>
        </div>
    );
}