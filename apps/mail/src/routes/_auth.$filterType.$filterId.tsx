import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EmailDetail} from "../components/mail/email-detail.tsx";
import {EmailDraft} from "../components/mail/email-draft.tsx";
import {
    useDeleteEmail,
    useEmail,
    useEmails,
    useMediaQuery,
    useSendDraft,
    useToggleReadEmail,
    useUpdateDraft
} from '@workspace/lib/mail';
import {EmailList} from "@/components/mail/email-list.tsx";
import {Email} from "@apps/api-server/types/mail";
import {toast} from "sonner";
import {EmailDraft as EmailDraftType} from "@apps/api-server/types/mail";
import {useEffect} from 'react';

// Define search params type
export interface MailSearchParams {
    mailId?: string;
    mode?: string;
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
        // Only set mode if mailId is not present
        const mode = (!mailId && typeof search.mode === 'string') ? search.mode : undefined;
        return {mailId, mode} as MailSearchParams;
    },
});

function MailRoute() {
    const {filterType, filterId} = Route.useParams();
    const {mailId, mode} = Route.useSearch();
    const navigate = useNavigate();
    const isMobile = useMediaQuery('(max-width: 768px)');
    const isTablet = useMediaQuery('(max-width: 1024px) and (min-width: 769px)');
    const deleteMail = useDeleteEmail();
    const toggleMailRead = useToggleReadEmail();
    const updateDraft = useUpdateDraft();
    const sendDraft = useSendDraft();

    const {data: emails = [], isLoading: isEmailsLoading, error: isEmailsError} = useEmails(filterId);
    const {data: selectedEmail = null} = useEmail(mailId);

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

    const handleDeleteEmail = async (mail: Email) => {
        console.log('delete email', mail.id)
        await deleteMail(mail);
        toast("Email deleted");
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    }

    const handleSendEmail = async (mail: EmailDraftType) => {
        console.log('send email', mail.id)
        await sendDraft.mutateAsync(mail);
        toast("Email sent");
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
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
        return selectedEmail  || mode === "compose" ? (
            <div className="flex-1 h-full w-full">
                {mode === "compose" || selectedEmail?.isDraft ? (
                    <EmailDraft
                        email={selectedEmail as EmailDraftType}
                        isMobile={true}
                        onBackClick={handleBackToList}
                        onDelete={handleDeleteEmail}
                        toggleMailRead={toggleMailRead}
                        sendDraft={handleSendEmail}
                        updateDraft={updateDraft.mutateAsync}
                    />
                ) : (
                    <EmailDetail
                        email={selectedEmail}
                        isMobile={true}
                        onBackClick={handleBackToList}
                        onDelete={handleDeleteEmail}
                        toggleMailRead={toggleMailRead}
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
                />
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
                />
            </div>

            {/* Email details column */}
            <div className="flex-1 h-full overflow-hidden">
                {selectedEmail  || mode === "compose" ? (
                    <div className="h-full">
                        {mode === "compose" || selectedEmail?.isDraft ? (
                            <EmailDraft
                                email={selectedEmail as EmailDraftType}
                                className="border-none h-full"
                                onDelete={handleDeleteEmail}
                                toggleMailRead={toggleMailRead}
                                sendDraft={handleSendEmail}
                                updateDraft={updateDraft.mutateAsync}
                            />
                        ) : (
                            <EmailDetail
                                email={selectedEmail}
                                className="border-none h-full"
                                onDelete={handleDeleteEmail}
                                toggleMailRead={toggleMailRead}
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