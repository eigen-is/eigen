import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { usePathInfos } from '@workspace/lib/drive';
import { useEmail, useEmails, useMailboxes } from '@workspace/lib/mail';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Email } from '@workspace/lib/types/mail';
import { isEmailDraft } from '@workspace/lib/types/mail';
import { EmptyState } from '@workspace/ui';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context.tsx';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useEffect, useMemo, useState } from 'react';
import { EmailDetail, EmailDetailToolbar } from '../components/mail/email-detail';
import { EmailDraft, EmailDraftToolbar } from '../components/mail/email-draft';
import { EmailList, EmailListToolbar } from '../components/mail/email-list';
import { useMailActions } from '../components/mail/hooks/use-mail-actions';
import { useMailList } from '../components/mail/hooks/use-mail-list';

export type MailSearchParams = {
    mailId?: string;
    mode?: string;
    to?: string;
    // `attach=<ownerId>/<mountId>/<pathId>,…` — cross-app channel for palette "Mail to…" /
    // Drive's "Mail to…" item menu. The route resolves each tuple to a DrivePath and hands
    // them to the composer, which runs them through the same handleDriveAttach the in-app
    // picker uses.
    attach?: string;
    // ?q= from a palette mail hit — highlighted in the open email body. Not latched-and-cleared
    // like the editors: the highlight is idempotent and stays active as the user moves between
    // emails. The list searchQuery filter is intentionally NOT seeded from it.
    q?: string;
};

function parseAttachRefs(attach: string | undefined): { ownerId: string; mountId: string; pathId: string }[] {
    if (!attach) return [];
    return attach
        .split(',')
        .map((entry) => entry.split('/'))
        .filter((parts): parts is [string, string, string] => parts.length === 3 && parts.every(Boolean))
        .map(([ownerId, mountId, pathId]) => ({ ownerId, mountId, pathId }));
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
        const to = typeof search.to === 'string' ? search.to.toLowerCase() : undefined;
        // mode='compose' can coexist with mailId — when auto-save assigns an id to a fresh compose,
        // we keep mode so the composer session stays stable (key-identity, toolbar, etc.).
        const mode = typeof search.mode === 'string' ? search.mode : undefined;
        const attach = typeof search.attach === 'string' ? search.attach : undefined;
        const q = typeof search.q === 'string' ? search.q : undefined;

        return { mailId, mode, to, attach, q } as MailSearchParams;
    },
});

function MailRoute() {
    const { filterType, filterId } = Route.useParams();
    const { mailId, mode, to, attach, q } = Route.useSearch();
    const navigate = useNavigate();
    const { isTablet } = useLayout();
    // Reply/Forward/Compose all write to history state (see use-mail-actions.ts). prefillDraft
    // seeds the composer; composeSessionKey is a nonce that flips the EmailDraft remount key
    // each time a new compose session starts, so an in-progress composer is unmounted cleanly.
    const { prefillDraft, composeSessionKey } = useLocation().state;

    // Cross-app drive attachments (palette "Mail to…") arrive via ?attach=. Resolve each
    // tuple to a DrivePath via the shared driveKeys.path cache, then hand the resolved list
    // to EmailDraft — which runs them through the same handleDriveAttach the toolbar's
    // Paperclip button uses, copying plain files via useAttachFromDrive and adding
    // containers as driveReferences. Wait until every query settles before publishing the
    // list so the composer's one-shot apply sees the complete set.
    const attachRefs = useMemo(() => parseAttachRefs(attach), [attach]);
    const pathQueries = usePathInfos(attachRefs);
    const allSettled = attachRefs.length > 0 && pathQueries.every((q) => !q.isPending);
    const initialDriveAttachments = useMemo<DrivePath[] | undefined>(() => {
        if (!allSettled) return undefined;
        const paths = pathQueries.map((q) => q.data).filter((p): p is DrivePath => !!p);
        return paths.length > 0 ? paths : undefined;
    }, [allSettled, pathQueries]);

    // Strip ?attach= from the URL after the queries settle, so a reload (or the auto-save's
    // ?mailId rewrite that preserves prev params) doesn't re-trigger the attachment flow.
    // The composer's prop snapshot already captured initialDriveAttachments — its one-shot
    // effect runs on the same commit.
    useEffect(() => {
        if (!attach) return;
        if (!allSettled) return;
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, attach: undefined }),
            state: true,
            replace: true,
        });
    }, [attach, allSettled, navigate, filterType, filterId]);

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

    // Ordered rows + selection + keyboard cursor live here (not in EmailList) so
    // Phase 2's useMailShortcuts can act on the same list the route renders.
    const { orderedEmails, selection, cursorIndex, setCursorIndex } = useMailList({
        emails: displayEmails,
        searchQuery,
        activeId: mailId,
    });

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

    const handleDeleteEmailById = async (emailId: string) => {
        const result = await actions.handleDeleteEmailById(emailId);
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
            onDelete={() => isEmailDraft(selectedEmail) && handleDeleteEmail(selectedEmail)}
            onAttach={() => setFilePickerOpen(true)}
            isSending={actions.isSendPending}
            hasId={!!selectedEmail?.id}
        />
    ) : selectedEmail ? (
        <EmailDetailToolbar
            email={selectedEmail}
            onDelete={handleDeleteEmailById}
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
                            orderedEmails={orderedEmails}
                            selection={selection}
                            cursorIndex={cursorIndex}
                            setCursorIndex={setCursorIndex}
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
                                email={isEmailDraft(selectedEmail) ? selectedEmail : null}
                                prefillDraft={prefillDraft}
                                to={to}
                                initialDriveAttachments={initialDriveAttachments}
                                signatureHtml={signatureHtml}
                                sendDraft={actions.handleSendEmail}
                                onAutoSave={actions.saveDraft}
                                onDraftIdAssigned={actions.handleDraftIdAssigned}
                                isSending={actions.isSendPending}
                                filePickerOpen={filePickerOpen}
                                onFilePickerOpenChange={setFilePickerOpen}
                            />
                        ) : (
                            <EmailDetail
                                email={selectedEmail}
                                toggleMailRead={actions.handleToggleMailRead}
                                highlightTerm={q}
                            />
                        )
                    ) : (
                        <EmptyState message="Select an email to view details" />
                    )}
                </Column>
            </ColumnLayout>
        </>
    );
}
