// The Docs editor page: the collaborative document opened from a route, drawn as one sheet of paper with its header
// and footer bands, its body and its notes, scaled to fit a narrow window, or, for a page-less doc, as a column of
// text at the reader's own width with room beside it for wide tables and images. Around the page it wires the
// toolbar and menus, the outline, the selection's properties panel, comments, chat and search, all through the
// body's, a band's or a note's editor, whichever holds the selection.

import type { Node } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { EditorContent } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { useAuth } from '@workspace/lib/auth';
import { useCollabDoc, useYjsUndoState } from '@workspace/lib/collab';
import {
    findCardIdByChatName,
    useCommentFilter,
    useCommentLifecycle,
    useDocumentPanels,
} from '@workspace/lib/comments';
import { useDocsTextWidth } from '@workspace/lib/docs';
import type { BandEdge, BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    BAND_ROOTS,
    bandEdge,
    FIRST_PAGE_BAND,
    normalStyleProperties,
    PAGE_ROOT,
    pagePx,
    pageStylesheet,
    readNormalStyle,
    readPageSetup,
    STYLE_ROOT,
} from '@workspace/lib/docs/eigendoc';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { EigenClipboardChartItem } from '@workspace/lib/types/clipboard';
import type { CardAttachmentDraft, CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import { CollabDocumentGate, Column, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import { downloadChartImage } from '@workspace/ui/components/charts';
import type { CommentContextMenuItem } from '@workspace/ui/components/comments';
import {
    CommentLifecycleDialogs,
    CommentLifecycleMenuItems,
    CommentMenuItems,
    PanelColumn,
} from '@workspace/ui/components/comments';
import {
    ClipboardMenuItems,
    ContextMenuAnchor,
    DownloadImageMenuItem,
    DownloadOriginalImageMenuItem,
    MenuSections,
    useContextMenu,
} from '@workspace/ui/components/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { PROPERTIES_PANEL_WIDTH_PX } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/search/prosemirror-search-highlight';
import { useElementSize } from '@workspace/ui/hooks/use-element-size';
import { cn } from '@workspace/ui/lib/utils';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { ChartDataEditor, ChartPropertiesPanel } from './chart-properties-panel';
import { chartClipboardItem, pasteFromClipboard, runClipboardCommand } from './clipboard';
import { useBandEditors, useDocEditor, useDocMedia } from './doc-editor';
import { EditorToolbar } from './editor-toolbar';
import { equationMenuSections } from './equation-menu-sections';
import { EquationPropertiesPanel } from './equation-properties-panel';
import {
    addCommentAnchor,
    CommentMark,
    canAnchorComment,
    commentAnchorText,
    commentCardIdAt,
    nodeCommentCardId,
    removeCommentAnchors,
    selectCommentAnchor,
    updateCommentDecorations,
} from './extensions/comment-mark';
import type { EquationOptions } from './extensions/equation';
import { insertNote } from './extensions/footnote';
import { TextBoxContext } from './extensions/text-box';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { FootnoteList } from './footnote-list';
import { useActiveComments } from './hooks/use-active-comments';
import { useOpenStory } from './hooks/use-open-story';
import { useOutlineShown } from './hooks/use-outline-shown';
import type { SelectionPanel } from './hooks/use-selection-panel';
import { useSelectionPanel } from './hooks/use-selection-panel';
import { cellBackground, selectCellCommands } from './hooks/use-toolbar-state';
import { useYMapRead } from './hooks/use-y-map-read';
import { updateNormalStyle } from './normal-style';
import { OUTLINE_WIDTH_PX, OutlineColumn } from './outline-sidebar';
import { BandControls, PageBands } from './page-band';
import type { PageNumberPreset } from './page-numbers';
import { applyPageNumberPreset } from './page-numbers';
import { createDocUndoManager, TEXT_WIDTHS, writePageSetup } from './page-setup';
import { tableMenuSections } from './table-menu-sections';
import { TablePropertiesPanel } from './table-properties-panel';

// What a cell's or an equation's right-click menu is about: the editor it is in and the comment card under the pointer.
type NodeMenuItem = { editor: Editor; comment: CommentContextMenuItem | null };
type TableMenuItem = NodeMenuItem & { cells: ReturnType<typeof selectCellCommands> & { cellBackground: string } };
type EquationMenuItem = NodeMenuItem & { display: boolean };

// The panel is an absolute overlay, so it covers all of the scroll box's content box but its p-4 gutter.
const PANEL_INTRUSION_PX = PROPERTIES_PANEL_WIDTH_PX - 16;
// The outline is an absolute overlay too, and covers the scroll box's p-4 gutter as well, which a page-less column keeps
// as room between the outline and the text.
const OUTLINE_INTRUSION_PX = OUTLINE_WIDTH_PX;
// Room an outline jump leaves above its heading, in screen pixels.
const JUMP_MARGIN = 24;
// A page-less doc's Full text width leaves this much beside the column, past the scroll box's own gutter, as Google's.
const FULL_WIDTH_GUTTER_PX = 48;
// Beside an open panel a page-less column narrows to end left of it, and moves left only once it is this narrow.
const PAGELESS_MIN_COLUMN_PX = 320;

export const CollaborativeEditor = ({
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: {
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    // No undoScope: the editor builds its own UndoManager for y-prosemirror's history plugin.
    const {
        doc: yDoc,
        provider,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
    } = useCollabDoc({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
    });

    return (
        <CollabDocumentGate collab={{ loaded, storageUnavailable, storageGone }} path={path} canWrite={canWrite}>
            {provider && yDoc && (
                <MediaResolverProvider
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    mediaFolderId={mediaFolderId}
                    chatFolderId={chatFolderId}
                >
                    <UnsyncedEditsGuard active={unsyncedEdits} />
                    <TiptapEditor
                        key={path.id}
                        path={path}
                        yDoc={yDoc}
                        provider={provider}
                        canWrite={canWrite}
                        offline={offline}
                        unsyncedEdits={unsyncedEdits}
                        storageUnavailable={storageUnavailable}
                        mediaFolderId={mediaFolderId}
                        chatFolderId={chatFolderId}
                        onAccessDialogOpen={onAccessDialogOpen}
                        initialChatName={initialChatName}
                        initialSearchTerm={initialSearchTerm}
                    />
                </MediaResolverProvider>
            )}
        </CollabDocumentGate>
    );
};

const TiptapEditor = ({
    yDoc,
    provider,
    path,
    canWrite,
    offline,
    unsyncedEdits,
    storageUnavailable,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    canWrite: boolean;
    offline: boolean;
    unsyncedEdits: boolean;
    storageUnavailable: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    const auth = useAuth();
    const media = useDocMedia(path);
    const [addOpen, setAddOpen] = useState(false);
    const [pendingMarkRange, setPendingMarkRange] = useState<{ from: number; to: number; text: string } | null>(null);
    const { isMobile } = useLayout();
    const {
        panel,
        commentPanelOpen,
        activityPanelOpen,
        mobilePanelOpen,
        toggleComments,
        toggleActivity,
        openComments,
        closePanels,
        onSearchOpenChange,
    } = useDocumentPanels(isMobile);
    const outline = useOutlineShown(isMobile);
    const outlinePaneOpen = isMobile && outline.shown;
    const outlineOverlayShown = !isMobile && outline.shown;
    const [docHeight, setDocHeight] = useState(0);
    // The image panel's button and Format › Image › Replace image open the same picker.
    const [replacePickerOpen, setReplacePickerOpen] = useState(false);
    // The chart panel's Edit data and a double-click on a chart open one dialog, for the selected chart.
    const [chartDataOpen, setChartDataOpen] = useState(false);
    const closeChartData = useCallback(() => setChartDataOpen(false), []);
    const needsScaleRef = useRef(false);
    const documentRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const handleAddCommentRef = useRef<(() => void) | null>(null);
    const allCommentsRef = useRef<CommentEntry[]>([]);
    const cardsRef = useRef<Record<string, CommentCard>>({});
    // The extensions keep the closures they were created with, so the figure, table and equation menus read this render's
    // state here.
    const figureContextMenuRef = useRef<(node: Node, pos: number, event: React.MouseEvent) => void>(() => {});
    const tableContextMenuRef = useRef<(editor: Editor, pos: number, event: MouseEvent) => boolean>(() => false);
    const equationContextMenuRef = useRef<(editor: Editor, node: Node, pos: number, event: React.MouseEvent) => void>(
        () => {},
    );
    const editEquationRef = useRef(() => {});
    const openNoteRef = useRef((_pos: number) => {});
    const openBoxRef = useRef((_pos: number, _at: { left: number; top: number } | null) => {});
    const insertFootnoteRef = useRef((): boolean => false);
    const leaveNoteRef = useRef(() => {});
    const [undoManager] = useState(() => createDocUndoManager(yDoc));
    const pageSetup = useYMapRead(yDoc.getMap(PAGE_ROOT), readPageSetup);
    const writeSetup = (from: PageSetup, to: PageSetup) => writePageSetup(yDoc, undoManager, from, to);
    const normalStyle = useYMapRead(yDoc.getMap(STYLE_ROOT), readNormalStyle);
    const { pageless } = pageSetup;
    const { textWidth, setTextWidth } = useDocsTextWidth();
    // The page at 96 dpi, for the layout math below and the text column before the page mounts.
    const page = pagePx(pageSetup);
    // Only the text column has to stay clear of the panel; the page's right margin may tuck under it.
    const textColumnRight = page.width - page.margin.right;

    const commentMenuItem = (cardId: string | null): CommentContextMenuItem | null => {
        const card = cardId ? cardsRef.current[cardId] : undefined;
        if (!card) return null;
        const entry = card.chatName ? allCommentsRef.current.find((c) => c.chatName === card.chatName) : undefined;
        return { card, entry };
    };

    const [setScrollContainer, scrollSize] = useElementSize(scrollContainerRef);
    // Past this the panel clears the centered page outright and every value below is pinned, so the math stops there.
    const panelClearWidth = 2 * (textColumnRight + PANEL_INTRUSION_PX) - page.width;
    const containerWidth = Math.min(scrollSize.width, panelClearWidth);

    // Hand-rolled rather than useElementSize: this measures the BORDER box, and stays quiet while
    // unscaled so a doc that needs no scaling never re-renders on its own growth.
    const setDocumentEl = useCallback((el: HTMLDivElement | null) => {
        documentRef.current = el;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            // Only the scaled branch reads docHeight; the effect below seeds it on the way in.
            if (!needsScaleRef.current) return;
            const height = el.offsetHeight;
            if (height === 0) return;
            setDocHeight(height);
        });
        ro.observe(el);
        return () => {
            documentRef.current = null;
            ro.disconnect();
        };
    }, []);

    // Same split as openCard below: the mobile pane hides the document, so a mark tap only opens the
    // card dialog over it.
    const handleCommentClick = useCallback(
        (cardId: string) => {
            if (!isMobile) openComments();
            setOpenCardId(cardId);
        },
        [isMobile, openComments],
    );

    // Every editor's equations open the one Equation panel and menu.
    const equation: Omit<EquationOptions, 'onOpenComment'> = {
        onEdit: isMobile ? undefined : () => editEquationRef.current(),
        onContextMenu: (...args) => equationContextMenuRef.current(...args),
    };
    const editor = useDocEditor(
        {
            media,
            yDoc,
            provider,
            editable: canWrite,
            target: { undoManager, cardIds: () => new Set(Object.keys(cardsRef.current)) },
            figure: {
                onOpenComment: handleCommentClick,
                onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
            },
            chart: {
                onOpenComment: handleCommentClick,
                onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
                onEditData: () => setChartDataOpen(true),
            },
            equation: { ...equation, onOpenComment: handleCommentClick },
            table: { onContextMenu: (...args) => tableContextMenuRef.current(...args) },
            footnote: { onOpen: (pos) => openNoteRef.current(pos), onInsert: () => insertFootnoteRef.current() },
            textBox: {
                onOpenComment: handleCommentClick,
                onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
                onOpen: (pos, at) => openBoxRef.current(pos, at),
            },
            extensions: [
                SearchHighlight,
                CommentMark.configure({
                    onCommentClick: handleCommentClick,
                    onCommentContextMenu: (cardId, event) => {
                        const item = commentMenuItem(cardId);
                        if (item) commentContextMenu.openAt(item, event.clientX, event.clientY);
                    },
                    onSelectionContextMenu: (event) => {
                        if (!handleAddCommentRef.current) return false;
                        selectionContextMenu.openAt(true, event.clientX, event.clientY);
                        return true;
                    },
                    onAddComment: () => handleAddCommentRef.current?.(),
                    onToggleCommentPanel: toggleComments,
                }),
            ],
        },
        [handleCommentClick, isMobile],
    );
    // The body's editor is built anew with its comment handler, and an upload settles into whichever holds the doc then.
    const editorRef = useRef<Editor | null>(null);
    editorRef.current = editor;

    // The band being edited in place: a writer's, on a desktop or a tablet. Explicit rather than the focused editor,
    // as a menu takes focus when it opens. Losing write access or the desktop leaves it, and a first page's band hands
    // over to the other pages' once Different first page goes off, a collaborator's untick too.
    const bandsAllowed = canWrite && !isMobile;
    const [editingBand, setEditingBand] = useState<BandRoot | null>(null);
    // A page-less doc draws no bands, so a switch to it, a collaborator's too, leaves the one being edited.
    if (editingBand && (!bandsAllowed || pageless)) setEditingBand(null);
    else if (editingBand && !pageSetup.differentFirstPage && editingBand !== bandEdge(editingBand)) {
        setEditingBand(bandEdge(editingBand));
    }
    // Esc puts the caret back where it was in the body.
    const leaveBand = () => {
        setEditingBand(null);
        editor.commands.focus();
    };
    const bands = useBandEditors({
        media,
        yDoc,
        provider,
        editable: canWrite,
        editing: editingBand,
        onLeave: leaveBand,
        equation,
        table: { onContextMenu: (...args) => tableContextMenuRef.current(...args) },
    });
    // The open footnote's one live editor, kept as long as the doc is open; it holds whichever note is open. A writer's
    // on a desktop or a tablet, as a band is.
    const noteEditor = useDocEditor({
        media,
        yDoc,
        provider: null,
        editable: canWrite,
        target: { body: () => editorRef.current, onLeave: () => leaveNoteRef.current(), story: 'footnote' },
        equation,
    });
    // The open text box's live editor, which draws in the box itself.
    const boxEditor = useDocEditor({
        media,
        yDoc,
        provider: null,
        editable: canWrite,
        target: { body: () => editorRef.current, onLeave: () => leaveNoteRef.current(), story: 'textBox' },
        equation,
    });
    const storyEditors = useMemo(() => ({ footnote: noteEditor, textBox: boxEditor }), [noteEditor, boxEditor]);
    const notes = useOpenStory(editor, storyEditors, bandsAllowed);
    leaveNoteRef.current = notes.leave;
    const openStory = (pos: number, at: { left: number; top: number } | null) => {
        setEditingBand(null);
        notes.open(pos, { focus: true, at, selection: null });
    };
    openNoteRef.current = (pos) => {
        if (bandsAllowed) openStory(pos, null);
    };
    // A box opens where a note does. On a phone and for a viewer it is selected instead, as no story opens there.
    openBoxRef.current = (pos, at) => {
        if (bandsAllowed) openStory(pos, at);
        else editor.commands.setNodeSelection(pos);
    };
    // Google's Insert › Footnote: the reference after the selection, and its note open with the caret in it. Where no
    // note opens, a viewer's and a phone's, none goes in: ⌘⌥F from a phone's keyboard would leave one nobody can edit.
    const insertFootnote = () => {
        const pos = bandsAllowed ? insertNote(editor) : null;
        if (pos !== null) openNoteRef.current(pos);
        return pos !== null;
    };
    insertFootnoteRef.current = insertFootnote;
    const storyEditor = notes.editor;
    const openBoxId = notes.anchor?.type === 'textBox' ? notes.anchor.id : null;
    const textBoxContext = useMemo(() => ({ openId: openBoxId, editor: boxEditor }), [openBoxId, boxEditor]);
    const activeEditor = editingBand ? bands[editingBand] : (storyEditor ?? editor);
    // A jump leaves a band or a note and puts the caret at the start of the heading, which scrolls to a small margin
    // below the top of the view: the selection's own scroll stops as soon as the heading shows, at the bottom. The
    // margin keeps a note number above the heading's line in view. A phone's pane closes first, and the scroll waits a
    // frame for the editor the pane hid to be drawn again.
    const jumpToHeading = (pos: number) => {
        setEditingBand(null);
        notes.close();
        if (isMobile) outline.close();
        editor.commands.focus(pos + 1, { scrollIntoView: false });
        requestAnimationFrame(() => {
            const heading = editor.view.nodeDOM(pos);
            const scroller = scrollContainerRef.current;
            if (!(heading instanceof Element) || !scroller) return;
            const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollBy({ top: top - JUMP_MARGIN });
        });
    };
    // A double-click puts the caret where it was, a menu at the band's end.
    const enterBand = (root: BandRoot, at?: { left: number; top: number }) => {
        notes.close();
        setEditingBand(root);
        const band = bands[root];
        band.commands.focus((at && band.view.posAtCoords(at)?.pos) ?? 'end');
    };
    // Page 1's header tops the long page, and the other pages' footer ends it.
    const entryBand = (edge: BandEdge) =>
        edge === 'header' && pageSetup.differentFirstPage ? FIRST_PAGE_BAND.header : edge;
    const applyPreset = (preset: PageNumberPreset) => {
        applyPageNumberPreset(bands, preset, pageSetup, writeSetup);
        enterBand(entryBand(preset.band));
    };
    // An image goes where the caret is and settles into that editor: a band's lives as long as the doc, and the body's
    // is read again once the upload lands. A story's settles in the body, which holds every story.
    const insertTarget = editingBand
        ? () => bands[editingBand]
        : storyEditor
          ? () => storyEditor
          : () => editorRef.current;
    const settleTarget = storyEditor ? () => editorRef.current : insertTarget;

    // From the undo manager's own events: it moves an undone step onto the redo stack after the transaction that undid
    // it, so an editor transaction reads the stacks too early.
    const { canUndo, canRedo } = useYjsUndoState(
        // A note's history is the body's.
        editingBand ? (yUndoPluginKey.getState(bands[editingBand].state)?.undoManager ?? null) : undoManager,
        canWrite,
    );

    const handleAddComment = () => {
        if (!chatFolderId) return;
        const { from, to } = editor.state.selection;
        const text = commentAnchorText(editor.state.doc, from, to);
        if (!text.trim()) return;
        setPendingMarkRange({ from, to, text });
        setAddOpen(true);
    };
    handleAddCommentRef.current = canWrite && chatFolderId ? handleAddComment : null;

    const { selectionPanel, equationFieldRef, editEquation, insertEquation } = useSelectionPanel(
        activeEditor,
        isMobile,
        closePanels,
    );
    editEquationRef.current = editEquation;
    const lastPanelRef = useRef<Exclude<SelectionPanel, 'document'>>('figure');
    if (selectionPanel !== 'document') lastPanelRef.current = selectionPanel;

    const activeComments = useActiveComments(editor);
    const lifecycle = useCommentLifecycle({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
    });
    const { allComments, cards, createCard, assignComment, members, assignedCount, setOpenCardId } = lifecycle;
    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    allCommentsRef.current = allComments;
    cardsRef.current = cards;

    const commentContextMenu = useContextMenu<CommentContextMenuItem>();
    const selectionContextMenu = useContextMenu<boolean>();
    const figureContextMenu = useContextMenu<{
        imagePath: DrivePath | undefined;
        chart: EigenClipboardChartItem | null;
        comment: CommentContextMenuItem | null;
    }>();
    // Opens only when a row will render; otherwise the browser's own menu shows.
    figureContextMenuRef.current = (node, pos, event) => {
        const imagePath = media.resolveMediaPath(node.attrs.mediaName ?? '');
        const chart = node.type.name === 'chart' ? chartClipboardItem(node) : null;
        const comment = commentMenuItem(nodeCommentCardId(node));
        if (!canWrite && !imagePath && !chart && !comment) return;
        // Selected first, so Add comment anchors to it.
        editor.commands.setNodeSelection(pos);
        figureContextMenu.handleContextMenu(event, { imagePath, chart, comment });
    };
    const menuChart = figureContextMenu.item?.chart;

    // A writer's table and equation menus, about what was right-clicked in `editor`: the body's, the band's being edited
    // or the open note's. A viewer, and a band not being edited, keep the browser's.
    const tableContextMenu = useContextMenu<TableMenuItem>();
    tableContextMenuRef.current = (target, pos, event) => {
        if (!target.isEditable) return false;
        // A right-click inside the selection keeps it, so a cell selection merges; elsewhere the caret goes there.
        const { state } = target;
        if (!state.selection.ranges.some(({ $from, $to }) => $from.pos <= pos && pos <= $to.pos)) {
            target.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos))));
        }
        const cells = { ...selectCellCommands(target, true), cellBackground: cellBackground(target.state) };
        const comment = commentMenuItem(commentCardIdAt(event.target));
        tableContextMenu.openAt({ editor: target, cells, comment }, event.clientX, event.clientY);
        return true;
    };
    const equationContextMenu = useContextMenu<EquationMenuItem>();
    equationContextMenuRef.current = (target, node, pos, event) => {
        if (!target.isEditable) return;
        // Selected as a click selects it, which opens its panel.
        target.chain().setNodeSelection(pos).setMeta('pointer', true).run();
        const comment = commentMenuItem(nodeCommentCardId(node));
        equationContextMenu.handleContextMenu(event, { editor: target, display: node.attrs.display === true, comment });
    };
    // Edit equation opens the panel once the menu has closed, or the menu would hand the focus back from its field.
    const afterEquationMenuRef = useRef<(() => void) | null>(null);

    const removeCommentMarks = (cardId: string) => {
        removeCommentAnchors(editor, cardId);
    };

    const handleSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            if (!pendingMarkRange) return;
            const range = pendingMarkRange;
            const card = await createCard({ title: pendingMarkRange.text, ...patch, attachments }, (card) =>
                addCommentAnchor(editor, range, card.id),
            );
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setPendingMarkRange(null);
            setAddOpen(false);
        },
        [editor, pendingMarkRange, createCard, assignComment],
    );

    // Sync resolved IDs + colors into the ProseMirror decoration plugin
    useEffect(() => {
        const resolved = new Set<string>();
        const colorMap = new Map<string, string>();
        for (const cardId of activeComments.ids) {
            const card = cards[cardId];
            if (!card) continue;
            if (card.color) colorMap.set(cardId, card.color);
            if (card.chatName) {
                const entry = allComments.find((c) => c.chatName === card.chatName);
                if (entry?.status === 'resolved') resolved.add(cardId);
            }
        }
        updateCommentDecorations(editor, resolved, colorMap);
    }, [editor, cards, allComments, activeComments.ids]);

    const docSearchController = useProseMirrorSearchController(editor, canWrite);
    // Find searches the body, so ⌘F leaves a band.
    const handleSearchOpenChange = useCallback(
        (open: boolean) => {
            if (open) setEditingBand(null);
            onSearchOpenChange(open);
        },
        [onSearchOpenChange],
    );
    const commentSearchHalf = useDocCommentSearchHalf(path.ownerId, path.mountId, path.id);

    // The properties panels follow the editor that has the selection. A chart's edits its data through the body's undo
    // manager, so a note's chart opens none.
    const showSidebar =
        !isMobile &&
        (panel !== null ||
            (canWrite && selectionPanel !== 'document' && (selectionPanel !== 'chart' || activeEditor === editor)));

    // Slide the centered page left by its overlap with the panel; only shrink once the slack runs out.
    const centredSlack = Math.max(0, (containerWidth - page.width) / 2);
    const panelLeft = containerWidth - PANEL_INTRUSION_PX;
    const panelOverlap = showSidebar ? Math.max(0, centredSlack + textColumnRight - panelLeft) : 0;
    const canShift = containerWidth > 0 && panelOverlap <= centredSlack;
    const canvasShift = canShift ? panelOverlap : 0;
    const canvasScale =
        containerWidth === 0 ? 1 : Math.min(1, containerWidth / page.width, canShift ? 1 : panelLeft / textColumnRight);
    // A page-less doc never scales: its column is laid out at the reader's width instead.
    const needsScale = !pageless && canvasScale < 1;

    // A page-less column is the reader's text width, centred, or the screen on a phone. An open panel narrows it to
    // end at the panel's edge, and the outline to start at its edge, then the panel moves it left below the floor. The
    // room right of it, to the scroll box's edge or the panel's, is the breakout strip a wide table scrolls in and a
    // wide image grows into (--breakout).
    const room = scrollSize.width;
    const widest = isMobile ? room : (TEXT_WIDTHS[textWidth].px ?? room - 2 * FULL_WIDTH_GUTTER_PX);
    const roomStart = outlineOverlayShown ? OUTLINE_INTRUSION_PX : 0;
    const roomEdge = showSidebar ? room - PANEL_INTRUSION_PX : room;
    const centredWidth = Math.min(widest, room);
    const centredLeft = (room - centredWidth) / 2;
    const clearLeft = Math.max(centredLeft, roomStart);
    const clearRight = Math.min(centredLeft + centredWidth, roomEdge);
    const columnWidth = Math.max(Math.min(centredWidth, PAGELESS_MIN_COLUMN_PX), clearRight - clearLeft);
    const columnLeft = Math.max(0, Math.min(clearLeft, roomEdge - columnWidth));
    const breakout = Math.max(0, roomEdge - columnLeft - columnWidth);
    const breakoutProperty: Record<string, string> = pageless ? { '--breakout': `${breakout}px` } : {};
    // On paper the @page rule draws the margins, as for pages, so the column is laid out for the screen only.
    const pagelessStylesheet =
        room > 0
            ? `@media screen { [data-document][data-pageless] { width: ${columnWidth}px; margin-left: ${columnLeft}px; padding: 48px 0 96px; } }`
            : `@media screen { [data-document][data-pageless] { width: 100%; max-width: ${widest > 0 ? `${widest}px` : 'none'}; margin: 0 auto; padding: 48px 0 96px; } }`;

    // The document observer stays quiet while unscaled, so seed the height on the way in.
    useLayoutEffect(() => {
        needsScaleRef.current = needsScale;
        if (needsScale && documentRef.current) setDocHeight(documentRef.current.offsetHeight);
    }, [needsScale]);

    // Desktop reveals the anchor and switches an activity tap over to comments; the mobile pane hides
    // the editor, so it just opens the card.
    const openCard = (cardId: string) => {
        setEditingBand(null);
        if (!isMobile) {
            openComments();
            selectCommentAnchor(editor, cardId);
        }
        setOpenCardId(cardId);
    };

    const panelProps = {
        onClose: closePanels,
        path,
        cards,
        entries: allComments,
        members,
        currentUserEmail: auth.user!.email,
        filter: commentFilter,
        activeComments,
        commentContextMenu,
        onOpenCard: openCard,
    };

    // Plain object per render; usePaletteDocSearch stabilises it, so reveal sees the current cards.
    const commentSearch: DocCommentSearch = {
        ...commentSearchHalf,
        reveal: (chatName) => {
            const cardId = findCardIdByChatName(cardsRef.current, chatName);
            if (!cardId) return;
            setEditingBand(null);
            openComments();
            // The mobile pane hides the editor, so scrolling would drive a view nobody can see.
            if (!isMobile) selectCommentAnchor(editor, cardId);
            setOpenCardId(cardId);
        },
    };

    // A cell's or an equation's comment rows: the card's under the pointer, else Add comment where one anchors, which
    // is in the body only. The card's Delete goes last, with the cell's or the equation's.
    const commentRows = (item: NodeMenuItem, anchors: boolean) => (
        <CommentLifecycleMenuItems
            lifecycle={lifecycle}
            item={item.comment}
            canWrite={canWrite}
            onAddComment={item.editor === editor && chatFolderId && anchors ? handleAddComment : undefined}
            part="rows"
        />
    );
    const commentDelete = (item: NodeMenuItem) => (
        <CommentLifecycleMenuItems
            lifecycle={lifecycle}
            item={item.comment}
            canWrite={canWrite}
            onDelete={removeCommentMarks}
            part="delete"
        />
    );
    const tableItem = tableContextMenu.item;
    const tableRows = tableItem && tableMenuSections(tableItem.editor, tableItem.cells);
    const equationItem = equationContextMenu.item;
    const equationRows =
        equationItem &&
        equationMenuSections(
            equationItem.editor,
            equationItem.display,
            isMobile
                ? undefined
                : () => {
                      afterEquationMenuRef.current = editEquation;
                  },
        );

    const bandControls = editingBand && (
        <BandControls
            band={editingBand}
            editor={bands[editingBand]}
            setup={pageSetup}
            onSetupChange={writeSetup}
            onDifferentFirstPage={(differentFirstPage) => {
                writeSetup(pageSetup, { ...pageSetup, differentFirstPage });
                // Ticked, what was typed stays the other pages' and the caret goes into page 1's new band, as in Google.
                const edge = bandEdge(editingBand);
                if (differentFirstPage) enterBand(FIRST_PAGE_BAND[edge]);
                else if (editingBand !== edge) enterBand(edge);
            }}
            onPageNumbers={applyPreset}
            onRemove={() => {
                bands[editingBand].commands.clearContent();
                leaveBand();
            }}
        />
    );

    return (
        <>
            <div className="flex h-full w-full overflow-hidden">
                {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
                <div className={cn('flex-1 min-w-0 h-full', (mobilePanelOpen || outlinePaneOpen) && 'hidden')}>
                    <DocSearchProvider
                        controller={docSearchController}
                        commentSearch={commentSearch}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={handleSearchOpenChange}
                        // right-68 = panel width + the bar's own gutter.
                        barClassName={cn('top-14', showSidebar && 'right-68')}
                        // No .focus(): focus stays in the bar so the user can keep replacing after ⌘Z.
                        onUndo={() => editor.commands.undo()}
                        onRedo={() => editor.commands.redo()}
                    >
                        <Column
                            id={'doc-editor'}
                            width={'w-full'}
                            toolbarBorder="always"
                            toolbar={
                                <EditorToolbar
                                    editor={activeEditor}
                                    body={editor}
                                    path={path}
                                    canWrite={canWrite}
                                    offline={offline}
                                    unsyncedEdits={unsyncedEdits}
                                    storageUnavailable={storageUnavailable}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    pageSetup={pageSetup}
                                    onPageSetupChange={writeSetup}
                                    textWidth={textWidth}
                                    onTextWidthChange={setTextWidth}
                                    onUpdateNormalStyle={
                                        editingBand || notes.anchor
                                            ? undefined
                                            : () => updateNormalStyle(yDoc, undoManager, editor, normalStyle)
                                    }
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    // Always offered: desktop draws the side panel, mobile the Column.
                                    onToggleCommentPanel={toggleComments}
                                    commentPanelOpen={commentPanelOpen}
                                    onToggleActivityPanel={toggleActivity}
                                    activityPanelOpen={activityPanelOpen}
                                    assignedCommentCount={assignedCount}
                                    onImageUpload={
                                        mediaFolderId
                                            ? (file) => media.uploadImage(insertTarget, file, settleTarget)
                                            : undefined
                                    }
                                    onImagePickFromDrive={
                                        mediaFolderId
                                            ? (paths) => media.insertFromDrive(insertTarget, paths)
                                            : undefined
                                    }
                                    onReplaceImage={() => setReplacePickerOpen(true)}
                                    // Comments anchor in the body only, and a band's or a note's equation comes from a paste
                                    // or a Word file, which its panel edits: Insert grays both out there.
                                    onAddComment={chatFolderId ? handleAddComment : undefined}
                                    onInsertEquation={insertEquation}
                                    onInsertFootnote={bandsAllowed ? insertFootnote : undefined}
                                    inNote={!!notes.anchor}
                                    onEnterBand={
                                        bandsAllowed && !pageless ? (edge) => enterBand(entryBand(edge)) : undefined
                                    }
                                    onPageNumbers={bandsAllowed && !pageless ? applyPreset : undefined}
                                    outlineShown={outline.shown}
                                    onToggleOutline={outline.toggle}
                                />
                            }
                        >
                            <div className="h-full relative overflow-hidden">
                                {/* The page box, and on paper the @page margins in its place; the printed clone matches it too. */}
                                <style>
                                    {pageStylesheet(pageSetup, '[data-document]')}
                                    {pageless && `\n${pagelessStylesheet}`}
                                </style>
                                <div
                                    ref={setScrollContainer}
                                    className={cn(
                                        'h-full w-full overflow-y-scroll p-4',
                                        // A page-less doc has no paper, so the whole view is its white, in dark mode too.
                                        pageless ? 'eigen-paper bg-white' : 'bg-muted',
                                        needsScale && 'overflow-x-hidden',
                                    )}
                                    onClick={(e) => {
                                        if (e.target === scrollContainerRef.current && !editingBand) {
                                            editor.commands.blur();
                                        }
                                    }}
                                    // While a band is edited a press in the body leaves it, the caret where it landed,
                                    // as in Google, and one in another band moves there, as that band is read-only
                                    // until entered; a press anywhere else would focus nothing, leaving the band
                                    // edited with Esc and typing reaching nothing, so it keeps the caret. A portaled
                                    // menu or dialog is the band's own. An open note is left and kept alike, and
                                    // another note opens itself.
                                    onMouseDown={
                                        notes.anchor && !editingBand
                                            ? (e) => {
                                                  const target = e.target;
                                                  if (
                                                      !(target instanceof Element) ||
                                                      !e.currentTarget.contains(target) ||
                                                      e.defaultPrevented ||
                                                      notes.editor?.view.dom.contains(target)
                                                  ) {
                                                      return;
                                                  }
                                                  if (target.closest('[data-page-body]')) notes.close();
                                                  else e.preventDefault();
                                              }
                                            : editingBand
                                              ? (e) => {
                                                    const target = e.target;
                                                    if (
                                                        !(target instanceof Element) ||
                                                        !e.currentTarget.contains(target)
                                                    ) {
                                                        return;
                                                    }
                                                    if (target.closest('[data-page-body]')) {
                                                        setEditingBand(null);
                                                        return;
                                                    }
                                                    const pressed = BAND_ROOTS.find((root) =>
                                                        bands[root].view.dom.contains(target),
                                                    );
                                                    if (pressed === editingBand) return;
                                                    e.preventDefault();
                                                    if (pressed)
                                                        enterBand(pressed, { left: e.clientX, top: e.clientY });
                                                }
                                              : undefined
                                    }
                                >
                                    <div
                                        data-document="true"
                                        data-pageless={pageless || undefined}
                                        className={cn(
                                            // eigen-paper: the page always renders light, in dark mode too (globals.css)
                                            // Rows: the header band, the body, the notes, the footer band.
                                            // isolate: the figures behind the text draw on the paper, in every scale.
                                            'eigen-paper isolate grid grid-rows-[auto_1fr_auto_auto] bg-white',
                                            pageless
                                                ? 'min-h-full'
                                                : 'rounded-lg shadow-sm shadow-transparent print:shadow-none',
                                            !pageless && !needsScale && 'min-h-full m-auto',
                                        )}
                                        ref={setDocumentEl}
                                        // The doc's Normal, which the body and the bands draw unformatted text in.
                                        style={{
                                            ...normalStyleProperties(normalStyle),
                                            ...breakoutProperty,
                                            ...(needsScale
                                                ? {
                                                      transform: `scale(${canvasScale})`,
                                                      transformOrigin: 'top left',
                                                      marginBottom: -(1 - canvasScale) * docHeight,
                                                  }
                                                : !pageless &&
                                                  canvasShift > 0 && {
                                                      transform: `translateX(${-canvasShift}px)`,
                                                  }),
                                        }}
                                    >
                                        {!pageless && (
                                            <PageBands
                                                edge="header"
                                                editors={bands}
                                                setup={pageSetup}
                                                editing={editingBand}
                                                onEnter={
                                                    bandsAllowed
                                                        ? (root, at) => enterBand(root ?? entryBand('header'), at)
                                                        : undefined
                                                }
                                                controls={bandControls}
                                            />
                                        )}
                                        <TextBoxContext.Provider value={textBoxContext}>
                                            <EditorContent
                                                editor={editor}
                                                data-page-body
                                                className="row-start-2 h-full min-w-0 tiptap-wrapper"
                                            />
                                        </TextBoxContext.Provider>
                                        <FootnoteList
                                            body={editor}
                                            note={noteEditor}
                                            open={notes.anchor}
                                            onOpen={bandsAllowed ? openStory : undefined}
                                        />
                                        {!pageless && (
                                            <PageBands
                                                edge="footer"
                                                editors={bands}
                                                setup={pageSetup}
                                                editing={editingBand}
                                                onEnter={
                                                    bandsAllowed
                                                        ? (root, at) => enterBand(root ?? entryBand('footer'), at)
                                                        : undefined
                                                }
                                                controls={bandControls}
                                            />
                                        )}
                                    </div>
                                </div>
                                {/* Unmounted when closed. The stable gutter ends the panel left of the scrollbar. The
                                    outline lies over the page's left side, so like a panel it moves no page; a
                                    page-less column keeps clear of both. */}
                                {(showSidebar || outlineOverlayShown) && (
                                    <div className="pointer-events-none absolute inset-0 overflow-hidden [scrollbar-gutter:stable]">
                                        {outlineOverlayShown && (
                                            <div className="pointer-events-auto absolute inset-y-0 left-0">
                                                <OutlineColumn
                                                    editor={editor}
                                                    onJump={jumpToHeading}
                                                    onClose={outline.close}
                                                />
                                            </div>
                                        )}
                                        {showSidebar && (
                                            <div className="pointer-events-auto absolute inset-y-0 right-0">
                                                {panel ? (
                                                    <PanelColumn activePanel={panel} {...panelProps} />
                                                ) : lastPanelRef.current === 'figure' ? (
                                                    <FigurePropertiesPanel
                                                        editor={activeEditor}
                                                        onReplaceImage={() => setReplacePickerOpen(true)}
                                                    />
                                                ) : lastPanelRef.current === 'chart' ? (
                                                    <ChartPropertiesPanel
                                                        editor={editor}
                                                        undoManager={undoManager}
                                                        onEditData={() => setChartDataOpen(true)}
                                                    />
                                                ) : lastPanelRef.current === 'equation' ? (
                                                    <EquationPropertiesPanel
                                                        editor={activeEditor}
                                                        fieldRef={equationFieldRef}
                                                    />
                                                ) : (
                                                    <TablePropertiesPanel editor={activeEditor} />
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </Column>
                    </DocSearchProvider>
                </div>

                {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}
                {outlinePaneOpen && <OutlineColumn editor={editor} onJump={jumpToHeading} onClose={outline.close} />}
            </div>

            <DrivePickerWithUpload
                open={replacePickerOpen}
                onOpenChange={setReplacePickerOpen}
                title="Replace image"
                canPick={(item) => isImageMime(item.mimeType)}
                onPickFromDrive={(paths) => media.replaceFromDrive(insertTarget, paths)}
                onPickFromDevice={(files) => files[0] && media.replaceImage(insertTarget, files[0], settleTarget)}
                accept="image/*"
            />

            {chartDataOpen && <ChartDataEditor editor={editor} undoManager={undoManager} onClose={closeChartData} />}

            <CardFormDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setPendingMarkRange(null);
                }}
                initialTitle={pendingMarkRange?.text ?? ''}
                onSave={handleSaveNew}
                allowAttachments={!!mediaFolderId}
                members={members}
                currentUserEmail={auth.user?.email}
                dialogTitle="New comment"
                submitLabel="Add comment"
            />

            <CommentLifecycleDialogs
                lifecycle={lifecycle}
                path={path}
                canWrite={canWrite}
                commentContextMenu={commentContextMenu}
                onDelete={removeCommentMarks}
            />

            <ContextMenuAnchor contextMenu={figureContextMenu}>
                <MenuSections
                    clipboard={
                        <ClipboardMenuItems
                            onCut={canWrite ? () => runClipboardCommand(editor, 'cut') : undefined}
                            onCopy={() => runClipboardCommand(editor, 'copy')}
                        />
                    }
                    output={
                        (figureContextMenu.item?.imagePath || menuChart) && (
                            <>
                                <DownloadOriginalImageMenuItem path={figureContextMenu.item?.imagePath} />
                                <DownloadImageMenuItem
                                    onDownload={menuChart ? () => downloadChartImage(menuChart) : undefined}
                                />
                            </>
                        )
                    }
                    collaborate={
                        <CommentLifecycleMenuItems
                            lifecycle={lifecycle}
                            item={figureContextMenu.item?.comment ?? null}
                            canWrite={canWrite}
                            onAddComment={chatFolderId ? handleAddComment : undefined}
                            part="rows"
                        />
                    }
                    destructive={
                        <>
                            {canWrite && (
                                <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => editor.chain().focus().deleteSelection().run()}
                                >
                                    <Trash2 className="h-4 w-4" /> Delete
                                </DropdownMenuItem>
                            )}
                            <CommentLifecycleMenuItems
                                lifecycle={lifecycle}
                                item={figureContextMenu.item?.comment ?? null}
                                canWrite={canWrite}
                                onDelete={removeCommentMarks}
                                part="delete"
                            />
                        </>
                    }
                />
            </ContextMenuAnchor>

            <ContextMenuAnchor contextMenu={tableContextMenu}>
                {tableItem && tableRows && (
                    <MenuSections
                        {...tableRows}
                        clipboard={
                            <ClipboardMenuItems
                                onCut={() => runClipboardCommand(tableItem.editor, 'cut')}
                                onCopy={() => runClipboardCommand(tableItem.editor, 'copy')}
                                onPaste={() => void pasteFromClipboard(tableItem.editor).catch(() => {})}
                            />
                        }
                        collaborate={commentRows(tableItem, canAnchorComment(tableItem.editor.state))}
                        destructive={
                            <>
                                {tableRows.destructive}
                                {commentDelete(tableItem)}
                            </>
                        }
                    />
                )}
            </ContextMenuAnchor>

            <ContextMenuAnchor
                contextMenu={equationContextMenu}
                onCloseAutoFocus={(e) => {
                    const after = afterEquationMenuRef.current;
                    afterEquationMenuRef.current = null;
                    e.preventDefault();
                    if (after) after();
                    else equationContextMenu.restoreFocus();
                }}
            >
                {equationItem && equationRows && (
                    <MenuSections
                        {...equationRows}
                        clipboard={
                            <ClipboardMenuItems
                                onCut={() => runClipboardCommand(equationItem.editor, 'cut')}
                                onCopy={() => runClipboardCommand(equationItem.editor, 'copy')}
                            />
                        }
                        collaborate={commentRows(equationItem, true)}
                        destructive={
                            <>
                                {equationRows.destructive}
                                {commentDelete(equationItem)}
                            </>
                        }
                    />
                )}
            </ContextMenuAnchor>

            <ContextMenuAnchor contextMenu={selectionContextMenu}>
                <CommentMenuItems
                    item={null}
                    onAddComment={() => {
                        handleAddCommentRef.current?.();
                        selectionContextMenu.close();
                    }}
                />
            </ContextMenuAnchor>
        </>
    );
};
