import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { usePathInfos } from '@workspace/lib/drive';
import { useEmail, useEmails, useMailboxes } from '@workspace/lib/mail';
import { useSearchQuery } from '@workspace/lib/search';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Email } from '@workspace/lib/types/mail';
import { isEmailDraft } from '@workspace/lib/types/mail';
import { Column, ColumnLayout, DeleteDialog, EmptyState, useLayout } from '@workspace/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmailDetail, EmailDetailToolbar } from '../components/mail/email-detail';
import { EmailDraft, EmailDraftToolbar } from '../components/mail/email-draft';
import { EmailList, EmailListToolbar } from '../components/mail/email-list';
import { useMailActions } from '../components/mail/hooks/use-mail-actions';
import { useMailList } from '../components/mail/hooks/use-mail-list';
import { useMailShortcuts } from '../components/mail/hooks/use-mail-shortcuts';
import { MailShortcutsDialog } from '../components/mail/mail-shortcuts-dialog';

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

    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [searchQuery, setSearchQuery] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteEmails, setPendingDeleteEmails] = useState<Email[]>([]);
    const {
        emails,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isLoading: isEmailsLoading,
        error: emailsError,
    } = useEmails(filterId);
    const { data: selectedEmail = null } = useEmail(mailId);
    const { data: mailboxes = [] } = useMailboxes();
    // Canonical mailbox identity for the list context menu — resolve the URL filterId ('inbox'/'sent'/…)
    // to the mailbox's canonical `path` (inbox = ''), the same identity EmailSummary.mailbox carries and
    // that emailKeys.list normalizes. Lets the menu hide the current box as a move target and drop the
    // already-satisfied Archive/Spam actions instead of offering no-op self-moves.
    const currentFolderId = mailboxes.find((m) => (m.path === '' ? 'inbox' : m.path.toLowerCase()) === filterId)?.path;
    const { data: spaceSettings } = useSpaceSettings();
    const signatureHtml = spaceSettings?.email?.signatures?.[0]?.html;

    // The search box hits the server FTS index scoped to the current mailbox instead of
    // client-filtering the loaded window. filterId ('inbox'/'sent'/…) is passed verbatim — the
    // BE canonicalises it (inbox -> ''); passing '' here would strip the filter and search all
    // mailboxes. Capped at the search route's max (50); results replace the paginated list while
    // searching.
    const isSearching = searchQuery.trim().length > 0;
    const { data: searchData, isFetching: isSearchFetching } = useSearchQuery({
        ownerId,
        q: searchQuery,
        sources: ['mail'],
        mailbox: filterId,
        limit: 50,
        enabled: isSearching,
    });
    const listEmails = isSearching ? (searchData?.mail ?? []) : emails;
    const isListLoading = isSearching ? isSearchFetching : isEmailsLoading;

    const actions = useMailActions();

    // Memoized so it keeps a stable identity across renders while a conversation is open —
    // otherwise the isRead remap yields a fresh array every render, re-running useMailList's
    // sort (costly at large mailbox sizes) and churning downstream effects.
    const displayEmails = useMemo(() => {
        const openId = selectedEmail?.id;
        if (!openId || !listEmails.some((m) => m.id === openId)) return listEmails;
        return listEmails.map((m) => (m.id === openId ? { ...m, isRead: true } : m));
    }, [listEmails, selectedEmail?.id]);

    // Ordered rows + selection + keyboard cursor live here (not in EmailList) so
    // useMailShortcuts can act on the same list the route renders.
    const { orderedEmails, selection, cursorIndex, setCursorIndex, setCursorById } = useMailList({
        emails: displayEmails,
        activeId: mailId,
    });

    // Gmail keyboard layer — opt-in via the space setting, inert while composing/editing a draft
    // or while the help overlay is open.
    const shortcutsEnabled = spaceSettings?.email?.keyboardShortcuts ?? false;
    const autoAdvance = spaceSettings?.email?.autoAdvance ?? 'older';
    const isComposing = mode === 'compose' || !!selectedEmail?.isDraft;
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [helpOpen, setHelpOpen] = useState(false);

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
        if (pendingDeleteEmails.length === 0) return;
        const failed = await actions.confirmDeleteEmails(pendingDeleteEmails);
        // Reject so the promise-aware DeleteDialog stays open on exactly the still-failed emails; each
        // failure was already surfaced by onMutationError. Narrowing the retained set first means a
        // retry re-hits only the failed ids.
        if (failed.length > 0) {
            setPendingDeleteEmails(failed);
            throw new Error('Some emails could not be permanently deleted');
        }
    };

    // Owns the open-conversation landing (auto-advance), shared by the detail toolbar and the
    // keyboard layer. The land target is computed BEFORE the mutation. The mutation is fired but
    // NOT awaited — navigation must be instant; blocking on the move/delete round-trip leaves the
    // user staring at the just-actioned email. The Trash confirm is decided from the open email's
    // own mailbox (no fetch), so no await is needed for that branch either.
    const actOnOpenEmail = (action: 'archive' | 'delete' | 'spam') => {
        const id = mailId;
        if (!id) return;
        const idx = orderedEmails.findIndex((e) => e.id === id);
        // idx<0 (open email not in the list) would make orderedEmails[idx+1]=[0] land on the top row
        // for 'older' — guard it so we fall back to the list instead of jumping to the first email.
        const landId =
            idx < 0 || autoAdvance === 'list'
                ? undefined
                : autoAdvance === 'older'
                  ? orderedEmails[idx + 1]?.id
                  : orderedEmails[idx - 1]?.id;
        if (action === 'delete') {
            if (selectedEmail?.mailbox === 'Trash') {
                setPendingDeleteEmails([selectedEmail]);
                setDeleteDialogOpen(true);
                return;
            }
            void actions.deleteEmailByIdOnly(id);
        } else {
            void actions.moveEmailByIdOnly(id, action === 'archive' ? 'Archive' : 'Junk');
        }
        if (landId) actions.handleRowClick(landId);
        else actions.navigateToList();
    };

    // Delete a single row by id, opening the Trash confirm dialog when needed. Resolves true once
    // actually deleted, false when the dialog was opened — lets the cursor path slide only on a
    // real delete.
    const requestDeleteById = async (emailId: string) => {
        const res = await actions.deleteEmailByIdOnly(emailId);
        if (res.needsConfirmation) {
            setPendingDeleteEmails(res.emails);
            setDeleteDialogOpen(true);
            return false;
        }
        return true;
    };

    useMailShortcuts({
        orderedEmails,
        cursorIndex,
        setCursorIndex,
        setCursorById,
        selection,
        isComposing,
        helpOpen,
        shortcutsEnabled,
        openEmailId: mailId,
        onRowClick: actions.handleRowClick,
        navigateToList: actions.navigateToList,
        navigateToMailbox: (targetFilterId: string) =>
            navigate({ to: Route.fullPath, params: { filterType: 'box', filterId: targetFilterId }, search: {} }),
        onCompose: actions.openCompose,
        focusSearch: () => searchInputRef.current?.focus(),
        openHelp: () => setHelpOpen((o) => !o),
        actOnOpenEmail,
        requestDeleteById,
        moveEmailByIdOnly: actions.moveEmailByIdOnly,
        setReadById: actions.setReadById,
        setFlaggedById: actions.setFlaggedById,
        setReadByIds: actions.setReadByIds,
        setFlaggedByIds: actions.setFlaggedByIds,
        archiveEmailsByIds: actions.handleArchiveEmailsByIds,
        reportSpamByIds: actions.handleReportSpamByIds,
        deleteEmailsByIds: handleDeleteEmailsByIds,
        onReply: actions.handleReplyEmail,
        onReplyAll: actions.handleReplyAllEmail,
        onForward: actions.handleForwardEmail,
        undoLast: actions.undoLast,
    });

    const [filePickerOpen, setFilePickerOpen] = useState(false);
    // isSendPending alone would leave the Send button live for the composer's flush + access probe,
    // so EmailDraft reports that earlier window here and both it and the toolbar read one flag.
    const [preparingSend, setPreparingSend] = useState(false);
    const isSending = actions.isSendPending || preparingSend;
    const listWidth = isTablet ? '320px' : '400px';
    const showDetail = !!(selectedEmail || mode === 'compose');
    const isDraft = mode === 'compose' || selectedEmail?.isDraft;

    const listToolbar = (
        <EmailListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            inputRef={searchInputRef}
            onShowShortcuts={() => setHelpOpen(true)}
        />
    );

    const detailToolbar = isDraft ? (
        <EmailDraftToolbar
            onDelete={() => isEmailDraft(selectedEmail) && handleDeleteEmail(selectedEmail)}
            onAttach={() => setFilePickerOpen(true)}
            isSending={isSending}
            hasId={!!selectedEmail?.id}
        />
    ) : selectedEmail ? (
        <EmailDetailToolbar
            email={selectedEmail}
            onDelete={() => actOnOpenEmail('delete')}
            onArchive={() => actOnOpenEmail('archive')}
            onReportSpam={() => actOnOpenEmail('spam')}
            onMoveToFolder={actions.handleMoveEmailToFolderById}
            onReply={actions.handleReplyEmail}
            onReplyAll={actions.handleReplyAllEmail}
            onForward={actions.handleForwardEmail}
            mailboxes={mailboxes}
        />
    ) : null;

    return (
        <>
            <MailShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} enabled={shortcutsEnabled} />
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
                <Column id="list" width={listWidth} onBack="sidebar" toolbar={listToolbar}>
                    <div className="flex flex-col border-r h-full overflow-hidden">
                        <EmailList
                            // View identity: on a mailbox switch OR any change to the search text,
                            // EmailList resets the virtualizer to the top. Folding the query in (not just
                            // isSearching) matters because refining one search into another keeps the same
                            // mailbox and stays "searching" — a drastic result-set size change under a
                            // scrolled position otherwise leaves the virtual window desynced from the scroll
                            // offset (blank list until you nudge the scroll).
                            resetKey={`${filterId}:${searchQuery.trim()}`}
                            orderedEmails={orderedEmails}
                            selection={selection}
                            cursorIndex={cursorIndex}
                            setCursorIndex={setCursorIndex}
                            isLoading={isListLoading}
                            error={emailsError}
                            // Paging only applies to the live mailbox; search returns a single capped set.
                            hasMore={!isSearching && !!hasNextPage}
                            isFetchingMore={isFetchingNextPage}
                            onLoadMore={fetchNextPage}
                            onRowClick={actions.handleRowClick}
                            activeRowId={mailId}
                            // The same gate the shortcuts layer uses: while the inline composer owns
                            // typing, the list must not grab or reclaim focus.
                            isComposing={isComposing}
                            mailboxes={mailboxes}
                            currentFolderId={currentFolderId}
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
                {/* Leaving compose is safe: EmailDraft saves the draft on unmount. */}
                <Column id="detail" width="flex" onBack={actions.navigateToList} toolbar={detailToolbar}>
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
                                isSending={isSending}
                                onPreparingSendChange={setPreparingSend}
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
