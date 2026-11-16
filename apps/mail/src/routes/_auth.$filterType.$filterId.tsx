// The mail app's one page: a mailbox's message list beside the open message or the composer. It reads
// the mailbox and message from the URL and the compose prefill from history state, and hands both to
// the list, the reader and the composer, which share one set of mail actions and shortcuts.

import { createFileRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { MAILBOX_ARCHIVE, MAILBOX_JUNK, MAILBOX_TRASH, mailboxRouteSegment } from '@workspace/lib/constants/mailboxes';
import { usePathInfos } from '@workspace/lib/drive';
import { useEmail, useEmails, useMailboxes } from '@workspace/lib/mail';
import { useSearchQuery } from '@workspace/lib/search';
import { useSpaceSettings } from '@workspace/lib/space';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Email } from '@workspace/lib/types/mail';
import { isEmailDraft } from '@workspace/lib/types/mail';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { Column, ColumnLayout, EmptyState, useLayout } from '@workspace/ui/components/layout/app';
import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmailDetail, EmailDetailToolbar } from '../components/mail/email-detail';
import { EmailDraft, EmailDraftToolbar } from '../components/mail/email-draft';
import { EmailList, EmailListToolbar } from '../components/mail/email-list';
import { useMailActions } from '../components/mail/hooks/use-mail-actions';
import { useMailList } from '../components/mail/hooks/use-mail-list';
import { useMailShortcuts } from '../components/mail/hooks/use-mail-shortcuts';
import { MailShortcutsDialog } from '../components/mail/mail-shortcuts-dialog';

type MailSearchParams = {
    mailId?: string;
    mode?: string;
    to?: string;
    // `<ownerId>/<mountId>/<pathId>,…`: Drive items to attach, sent by another app's Mail to….
    attach?: string;
    // A search hit's terms, highlighted in each email the user opens. The list is not filtered by it.
    q?: string;
};

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: MailRoute,
    validateSearch: (search: Record<string, unknown>): MailSearchParams => ({
        mailId: typeof search.mailId === 'string' ? search.mailId : undefined,
        // mode stays 'compose' once auto-save gives a new draft its mailId, so the composer keeps its session.
        mode: typeof search.mode === 'string' ? search.mode : undefined,
        to: typeof search.to === 'string' ? search.to.toLowerCase() : undefined,
        attach: typeof search.attach === 'string' ? search.attach : undefined,
        q: typeof search.q === 'string' ? search.q : undefined,
    }),
});

function MailRoute() {
    const { filterType, filterId } = Route.useParams();
    const { mailId, mode, to, attach, q } = Route.useSearch();
    const navigate = useNavigate();
    const { isTablet } = useLayout();
    // Reply, Forward and Compose hand the composer its prefill through history state. A new composeSessionKey
    // starts a new compose session, which remounts the composer.
    const { prefillDraft, forwardedParts, composeSessionKey } = useLocation().state;

    // The composer applies its Drive attachments once, so the list waits until every ?attach= item has resolved.
    const attachRefs = useMemo(() => parseAttachRefs(attach), [attach]);
    const pathQueries = usePathInfos(attachRefs);
    const allSettled = attachRefs.length > 0 && pathQueries.every((q) => !q.isPending);
    const initialDriveAttachments = useMemo<DrivePath[] | undefined>(() => {
        if (!allSettled) return undefined;
        const paths = pathQueries.map((q) => q.data).filter((p): p is DrivePath => !!p);
        return paths.length > 0 ? paths : undefined;
    }, [allSettled, pathQueries]);

    // Drop ?attach= once resolved, or a reload or auto-save's ?mailId rewrite would attach the items again.
    useEffect(() => {
        if (!allSettled) return;
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, attach: undefined }),
            state: true,
            replace: true,
        });
    }, [allSettled, navigate, filterType, filterId]);

    const { user } = Route.useRouteContext();
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
    const { data: selectedEmail = null, isPending: isEmailPending } = useEmail(mailId);
    const { data: mailboxes = [] } = useMailboxes();
    // The URL's 'inbox' as the mailbox path an email carries ('INBOX'), so the list menu can hide the current
    // box as a move target and leave out an Archive or Spam that would move nothing.
    const currentFolderId = mailboxes.find((m) => mailboxRouteSegment(m.path) === filterId)?.path;
    const { data: spaceSettings } = useSpaceSettings();
    const signatureHtml = spaceSettings?.email?.signatures?.[0]?.html;

    // Search asks the server's index for this mailbox, capped at the search route's 50 hits, and its results
    // replace the paged list while it runs.
    const isSearching = searchQuery.trim().length > 0;
    const { data: searchData, isFetching: isSearchFetching } = useSearchQuery({
        ownerId: user.id,
        q: searchQuery,
        sources: ['mail'],
        mailbox: filterId,
        limit: 50,
        enabled: isSearching,
    });
    const listEmails = isSearching ? (searchData?.mail ?? []) : emails;
    const isListLoading = isSearching ? isSearchFetching : isEmailsLoading;

    const actions = useMailActions();

    // Memoized, or the isRead remap makes a new array each render and useMailList sorts a large mailbox again.
    const displayEmails = useMemo(() => {
        const openId = selectedEmail?.id;
        if (!openId || !listEmails.some((m) => m.id === openId)) return listEmails;
        return listEmails.map((m) => (m.id === openId ? { ...m, isRead: true } : m));
    }, [listEmails, selectedEmail?.id]);

    // The ordered rows, selection and cursor live here, not in EmailList, so the shortcuts act on the list shown.
    const { orderedEmails, selection, cursorIndex, setCursorIndex, setCursorById } = useMailList({
        emails: displayEmails,
        activeId: mailId,
    });

    // Opening a row also selects it, so the batch keys act on the message the user is reading.
    const openEmail = (emailId: string) => {
        selection.setSelection([emailId]);
        actions.handleRowClick(emailId);
    };

    // The keyboard shortcuts are opt-in, and inert while composing or while their help is open.
    const shortcutsEnabled = spaceSettings?.email?.keyboardShortcuts ?? false;
    const autoAdvance = spaceSettings?.email?.autoAdvance ?? 'older';
    const isComposing = mode === 'compose' || !!selectedEmail?.isDraft;
    const searchInputRef = useRef<HTMLInputElement>(null);
    // Delete and Backspace act only while focus is inside this element.
    const mailSurfaceRef = useRef<HTMLDivElement>(null);
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

    // The move or delete is not awaited: waiting for the round trip would leave the actioned email on screen.
    // So the next email to open is picked before it starts.
    const actOnOpenEmail = (action: 'archive' | 'delete' | 'spam') => {
        const id = mailId;
        if (!id) return;
        const idx = orderedEmails.findIndex((e) => e.id === id);
        // An open email missing from the list goes back to the list, not to the top row.
        const landId =
            idx < 0 || autoAdvance === 'list'
                ? undefined
                : autoAdvance === 'older'
                  ? orderedEmails[idx + 1]?.id
                  : orderedEmails[idx - 1]?.id;
        if (action === 'delete') {
            if (selectedEmail?.mailbox === MAILBOX_TRASH) {
                setPendingDeleteEmails([selectedEmail]);
                setDeleteDialogOpen(true);
                return;
            }
            void actions.deleteEmailByIdOnly(id);
        } else {
            void actions.moveEmailByIdOnly(id, action === 'archive' ? MAILBOX_ARCHIVE : MAILBOX_JUNK);
        }
        if (landId) openEmail(landId);
        else actions.navigateToList();
    };

    // False when the Trash confirm opened instead, so the cursor moves on only after a real delete.
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
        surfaceRef: mailSurfaceRef,
        isComposing,
        helpOpen,
        shortcutsEnabled,
        openEmailId: mailId,
        onRowClick: openEmail,
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
    const showDetail = !!mailId || mode === 'compose';
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
                    pendingDeleteEmails.length === 1 ? 'Delete email' : `Delete ${pendingDeleteEmails.length} emails`
                }
                description={
                    pendingDeleteEmails.length === 1
                        ? 'Are you sure you want to permanently delete this email'
                        : `Are you sure you want to permanently delete ${pendingDeleteEmails.length} emails`
                }
                itemName={pendingDeleteEmails.length === 1 ? pendingDeleteEmails[0]?.subject || undefined : undefined}
                onDelete={() => actions.confirmDeleteEmails(pendingDeleteEmails, setPendingDeleteEmails)}
            />
            {/* display:contents, so the ref hangs on a real node without changing the layout. */}
            <div ref={mailSurfaceRef} className="contents">
                <ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
                    <Column id="list" width={showDetail ? listWidth : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                        <div className={cn('flex flex-col h-full overflow-hidden', showDetail && 'border-r')}>
                            <EmailList
                                // A new mailbox or search text scrolls the list to the top. A refined search
                                // that shrinks the results would otherwise keep a scroll offset past the end.
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
                                onRowClick={openEmail}
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
                    {showDetail && (
                        <Column id="detail" width="flex" onBack={actions.navigateToList} toolbar={detailToolbar}>
                            {isDraft ? (
                                <EmailDraft
                                    // A compose session stays mounted across auto-save's URL update. An open
                                    // draft keys on its id, because the editor reads its content on mount only.
                                    key={
                                        mode === 'compose'
                                            ? `compose-${composeSessionKey ?? 'fresh'}`
                                            : (selectedEmail?.id ?? 'empty')
                                    }
                                    email={isEmailDraft(selectedEmail) ? selectedEmail : null}
                                    prefillDraft={prefillDraft}
                                    forwardedParts={forwardedParts}
                                    to={to}
                                    initialDriveAttachments={initialDriveAttachments}
                                    signatureHtml={signatureHtml}
                                    sendDraft={actions.handleSendEmail}
                                    onAutoSave={actions.saveDraft}
                                    onDraftIdAssigned={actions.handleDraftIdAssigned}
                                    onForwardedPartsSaved={actions.handleForwardedPartsSaved}
                                    isSending={isSending}
                                    onPreparingSendChange={setPreparingSend}
                                    filePickerOpen={filePickerOpen}
                                    onFilePickerOpenChange={setFilePickerOpen}
                                />
                            ) : selectedEmail ? (
                                <EmailDetail
                                    email={selectedEmail}
                                    toggleMailRead={actions.handleToggleMailRead}
                                    highlightTerm={q}
                                    remoteImagesLoaded={actions.imagesLoadedFor === selectedEmail.id}
                                    onLoadRemoteImages={() => actions.loadRemoteImages(selectedEmail.id)}
                                />
                            ) : isEmailPending ? null : (
                                <EmptyState message="Email not found" />
                            )}
                        </Column>
                    )}
                </ColumnLayout>
            </div>
        </>
    );
}

function parseAttachRefs(attach: string | undefined): { ownerId: string; mountId: string; pathId: string }[] {
    if (!attach) return [];
    return attach
        .split(',')
        .map((entry) => entry.split('/'))
        .filter((parts): parts is [string, string, string] => parts.length === 3 && parts.every(Boolean))
        .map(([ownerId, mountId, pathId]) => ({ ownerId, mountId, pathId }));
}
