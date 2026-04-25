import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useEmail, useEmails, useMailboxes } from '@workspace/lib/mail';
import { useSpaceSettings } from '@workspace/lib/space';
import type { Email, EmailDraft as EmailDraftType } from '@workspace/lib/types/mail';
import { EmptyState } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useState } from 'react';
import { EmailDetail, EmailDetailToolbar } from '../components/mail/email-detail';
import { EmailDraft, EmailDraftToolbar } from '../components/mail/email-draft';
import { EmailList, EmailListToolbar } from '../components/mail/email-list';
import { useMailActions } from '../components/mail/hooks/use-mail-actions';

export type MailSearchParams = {
    mailId?: string;
    mode?: string;
    to?: string;
};

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
        const to = typeof search.to === 'string' ? search.to.toLowerCase() : undefined;
        // mode='compose' can coexist with mailId — when auto-save assigns an id to a fresh compose,
        // we keep mode so the composer session stays stable (key-identity, toolbar, etc.).
        const mode = typeof search.mode === 'string' ? search.mode : undefined;

        return { mailId, mode, to } as MailSearchParams;
    },
});

function MailRoute() {
    const { filterId } = Route.useParams();
    const { mailId, mode, to } = Route.useSearch();
    const { isTablet } = useLayout();
    // Reply/Forward/Compose all write to history state (see use-mail-actions.ts). prefillDraft
    // seeds the composer; composeSessionKey is a nonce that flips the EmailDraft remount key
    // each time a new compose session starts, so an in-progress composer is unmounted cleanly.
    const { prefillDraft, composeSessionKey } = useLocation().state;

    const [searchQuery, setSearchQuery] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteEmails, setPendingDeleteEmails] = useState<Email[]>([]);
    const { data: emails = [], isLoading: isEmailsLoading, error: emailsError } = useEmails(filterId);
    const { data: selectedEmail = null } = useEmail(mailId);
    const { data: mailboxes = [] } = useMailboxes();
    const { data: spaceSettings } = useSpaceSettings();
    const signatureHtml = spaceSettings?.email?.signatures?.[0]?.html;

    const actions = useMailActions();

    const selectedEmailInData = emails.find((m) => m.id === selectedEmail?.id);
    const displayEmails = selectedEmailInData
        ? emails.map((m) => (m.id === selectedEmail?.id ? { ...m, isRead: true } : m))
        : emails;

    const handleDeleteEmail = async (mail: Email) => {
        const result = await actions.handleDeleteEmail(mail);
        if (result.needsConfirmation) {
            setPendingDeleteEmails(result.emails);
            setDeleteDialogOpen(true);
        }
    };

    const handleDeleteEmailsByIds = async (emailIds: string[]) => {
        const result = await actions.handleDeleteEmailsByIds(emailIds);
        if (result.needsConfirmation) {
            setPendingDeleteEmails(result.emails);
            setDeleteDialogOpen(true);
        }
    };

    const confirmDeleteEmails = async () => {
        if (pendingDeleteEmails.length > 0) {
            await actions.confirmDeleteEmails(pendingDeleteEmails);
            setDeleteDialogOpen(false);
            setPendingDeleteEmails([]);
        }
    };

    const [filePickerOpen, setFilePickerOpen] = useState(false);
    const listWidth = isTablet ? '320px' : '400px';
    const showDetail = !!(selectedEmail || mode === 'compose');
    const isDraft = mode === 'compose' || selectedEmail?.isDraft;

    const listToolbar = <EmailListToolbar searchQuery={searchQuery} onSearchChange={setSearchQuery} />;

    const detailToolbar = isDraft ? (
        <EmailDraftToolbar
            onDelete={() => handleDeleteEmail(selectedEmail as EmailDraftType)}
            onAttach={() => setFilePickerOpen(true)}
            isSending={actions.isSendPending}
            hasId={!!selectedEmail?.id}
        />
    ) : selectedEmail ? (
        <EmailDetailToolbar
            email={selectedEmail}
            onDelete={actions.handleDeleteEmailById}
            onArchive={actions.handleArchiveEmailById}
            onReportSpam={actions.handleReportSpamById}
            onMoveToFolder={actions.handleMoveEmailToFolderById}
            onReply={actions.handleReplyEmail}
            onReplyAll={actions.handleReplyAllEmail}
            onForward={actions.handleForwardEmail}
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
                title={
                    pendingDeleteEmails.length === 1 ? 'Delete Email' : `Delete ${pendingDeleteEmails.length} Emails`
                }
                description={
                    pendingDeleteEmails.length === 1
                        ? 'Are you sure you want to permanently delete this email'
                        : `Are you sure you want to permanently delete ${pendingDeleteEmails.length} emails`
                }
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
                            error={emailsError}
                            onRowClick={actions.handleRowClick}
                            activeRowId={mailId}
                            mailboxes={mailboxes}
                            onDelete={handleDeleteEmailsByIds}
                            onArchive={actions.handleArchiveEmailsByIds}
                            onReportSpam={actions.handleReportSpamByIds}
                            onMoveToFolder={actions.handleMoveEmailsToFolderByIds}
                            onReply={actions.handleReplyEmail}
                            onReplyAll={actions.handleReplyAllEmail}
                            onForward={actions.handleForwardEmail}
                        />
                    </div>
                </Column>
                <Column
                    id="detail"
                    width="flex"
                    onBack={isDraft ? undefined : actions.navigateToList}
                    toolbar={detailToolbar}
                >
                    {showDetail ? (
                        isDraft ? (
                            <EmailDraft
                                // Identity key: within one compose session (mode='compose' +
                                // same composeSessionKey), the composer stays mounted across
                                // the auto-save URL update. A new Reply/Forward/Compose click
                                // bumps composeSessionKey, forcing a remount. For draft
                                // detail (mode absent), keying on mailId lets LightEditor pick
                                // up fresh initial content — Tiptap's useEditor reads
                                // `content` on mount only.
                                key={
                                    mode === 'compose'
                                        ? `compose-${composeSessionKey ?? 'fresh'}`
                                        : (selectedEmail?.id ?? 'empty')
                                }
                                email={selectedEmail as EmailDraftType}
                                prefillDraft={prefillDraft}
                                to={to}
                                signatureHtml={signatureHtml}
                                sendDraft={actions.handleSendEmail}
                                onAutoSave={actions.saveDraft}
                                onDraftIdAssigned={actions.handleDraftIdAssigned}
                                isSending={actions.isSendPending}
                                filePickerOpen={filePickerOpen}
                                onFilePickerOpenChange={setFilePickerOpen}
                            />
                        ) : (
                            <EmailDetail email={selectedEmail} toggleMailRead={actions.handleToggleMailRead} />
                        )
                    ) : (
                        <EmptyState message="Select an email to view details" />
                    )}
                </Column>
            </ColumnLayout>
        </>
    );
}
