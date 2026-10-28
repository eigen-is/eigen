// Builds every editor of a doc: the body's, each header and footer band's and the open footnote's. One factory gives
// them the schema, the node views, the collaboration and its caret, and the copy, paste and drop paths, so a band and a
// note edit as the body does. useDocEditor and useBandEditors add what a mounted editor runs, such as the sweep of
// images a closed tab left mid-upload, and useDocMedia holds the image uploads they share.

import type { Extensions } from '@tiptap/core';
import { Extension, Node } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Slice } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import type { Editor, UseEditorOptions } from '@tiptap/react';
import { useEditor } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { useAuth } from '@workspace/lib/auth';
import type { ClassifiedSvg } from '@workspace/lib/clipboard';
import {
    classifyPaste,
    clipboardTextItemHasContent,
    hasRichHtmlBeyondMarker,
    materializeClipboardSvg,
    needsReUpload,
    reUploadImage,
} from '@workspace/lib/clipboard';
import { userColor } from '@workspace/lib/constants/colors';
import { FOOTNOTE_FONT_SIZE, getFontName } from '@workspace/lib/constants/fonts';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import {
    BAND_EXCLUDED_NODES,
    DOC_PROSE_CLASS,
    flattenNestedFootnotes,
    getDocExtensions,
    PAGE_BAND_CLASS,
    PAGE_ROOT,
    pagePx,
    readNormalStyle,
    readPageSetup,
    STYLE_ROOT,
} from '@workspace/lib/docs/eigendoc';
import {
    isPendingMediaName,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { renderPresenceCaret } from '@workspace/ui/components/collab';
import { common, createLowlight } from 'lowlight';
import type { DependencyList } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { insertEigenItems, writeDocsClipboard } from './clipboard';
import { AtomMarks } from './extensions/atom-marks';
import type { ChartOptions } from './extensions/chart';
import { Chart } from './extensions/chart';
import type { EquationOptions } from './extensions/equation';
import { Equation } from './extensions/equation';
import { Figure } from './extensions/figure';
import type { FigureFrameOptions } from './extensions/figure-frame';
import type { FootnoteOptions } from './extensions/footnote';
import { Footnote, NOTE_EDIT, NoteDecorations, NoteFormatting } from './extensions/footnote';
import { PageNumber } from './extensions/page-number';
import { PositionedFigures } from './extensions/positioned-figure';
import { cellPosAt, EditorTable } from './extensions/table';
import type { TableOfContentsOptions } from './extensions/table-of-contents';
import { TableOfContents } from './extensions/table-of-contents';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { cleanPastedHTML } from './paste';

const lowlight = createLowlight(common);

const NO_CARDS: ReadonlySet<string> = new Set();

function swapFigureMediaName(editor: Editor, pendingName: string, newName: string | null) {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure' && node.attrs.mediaName === pendingName) {
            positions.push(pos);
        }
        return true;
    });
    if (positions.length === 0) return;
    editor.commands.command(({ tr, dispatch }) => {
        // Iterate in reverse so earlier positions stay valid after later deletes
        for (let i = positions.length - 1; i >= 0; i--) {
            const pos = positions[i];
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            if (newName === null) {
                tr.delete(pos, pos + node.nodeSize);
            } else {
                tr.setNodeAttribute(pos, 'mediaName', newName);
            }
        }
        // A note's image takes its name too, a change to a note the body otherwise never makes.
        if (dispatch) dispatch(tr.setMeta(NOTE_EDIT, true));
        return true;
    });
}

// The textStyle `fontFamily` attr is an EIGEN_FONTS name, but a stored doc may hold a full CSS stack and
// y-prosemirror hydrates without parseHTML, so this pass collapses a known stack to its name on editable
// load. renderHTML maps the name back to the same stack. Kept out of the undo history.
function normalizeFontFamilyMarks(editor: Editor) {
    const markType = editor.schema.marks.textStyle;
    if (!markType) return;
    const targets: { from: number; to: number; attrs: Record<string, unknown> }[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type === markType);
        if (!mark) return;
        const family = mark.attrs.fontFamily;
        if (typeof family !== 'string' || !family) return;
        const canon = getFontName(family);
        if (canon === family) return;
        targets.push({ from: pos, to: pos + node.nodeSize, attrs: { ...mark.attrs, fontFamily: canon } });
    });
    if (targets.length === 0) return;
    editor.commands.command(({ tr, dispatch }) => {
        for (const { from, to, attrs } of targets) {
            tr.addMark(from, to, markType.create(attrs));
        }
        // A note's text takes its name too, a change to a note the body otherwise never makes.
        tr.setMeta('addToHistory', false).setMeta(NOTE_EDIT, true);
        if (dispatch) dispatch(tr);
        return true;
    });
}

// The image paths every docs editor shares. Each takes the editor it acts on as a getter, read again once an upload
// settles: the body's editor is built anew when its handlers change, so the name swaps in whichever holds the doc then.
export function useDocMedia(path: DrivePath) {
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(path.ownerId, path.mountId);
    const { mediaFolderId, startUpload, resolveMediaPath } = useMediaResolver();

    // `settle` holds the doc's fragment once the upload lands: for an image put in a note, the body, which holds every
    // note, open or not, as the note's editor may have moved on to another.
    const uploadImage = async (editor: () => Editor | null, file: File, settle = editor) => {
        const target = editor();
        if (!mediaFolderId || !file.type.startsWith('image/') || !target) return;
        const { pendingName, promise } = startUpload(file);
        target.chain().focus().setFigure({ mediaName: pendingName }).run();
        const result = await promise;
        const settled = settle();
        if (settled && !settled.isDestroyed) swapFigureMediaName(settled, pendingName, result?.name ?? null);
    };

    return {
        mediaFolderId,
        resolveMediaPath,
        uploadImage,
        // A vector SVG payload (or a pasted SVG document) lands as a figure through the exact image-upload path:
        // stored in media/, served as-is, rendered by <image>. Its images are name-referenced (eigen-media:);
        // materialize re-uploads each into our media/ and rewrites the svg's refs before it's stored.
        uploadSvg: async (editor: () => Editor | null, { svg, items }: ClassifiedSvg, settle = editor) => {
            if (!mediaFolderId) return;
            const file = await materializeClipboardSvg(svg, items, mediaFolderId, uploadFile.mutateAsync);
            await uploadImage(editor, file, settle);
        },
        insertFromDrive: async (editor: () => Editor | null, paths: DrivePath[]) => {
            if (!mediaFolderId) return;
            const results = await copyToMediaFolder.mutateAsync({ paths, mediaFolderId }).catch(() => null);
            const settled = editor();
            if (!results || !settled || settled.isDestroyed) return;
            for (const result of results) {
                settled.chain().focus().setFigure({ mediaName: result.name }).run();
            }
        },
        replaceImage: async (editor: () => Editor | null, file: File, settle = editor) => {
            const target = editor();
            if (!mediaFolderId || !file.type.startsWith('image/') || !target) return;
            const { pendingName, promise } = startUpload(file);
            // The new picture takes its own size and ratio on load, never the old one's stretched box.
            target.chain().focus().updateFigure({ mediaName: pendingName, width: null, height: null }).run();
            const result = await promise;
            const settled = settle();
            if (settled && !settled.isDestroyed) swapFigureMediaName(settled, pendingName, result?.name ?? null);
        },
        replaceFromDrive: async (editor: () => Editor | null, paths: DrivePath[]) => {
            const target = editor();
            if (!mediaFolderId || !target || paths.length === 0) return;
            const replaced = target.getAttributes('figure').mediaName;
            const result = await copyToMediaFolder.mutateAsync({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            const settled = editor();
            // The selection may have left the figure during the copy; the copied file then stays unreferenced in media/.
            if (result?.[0] && settled && !settled.isDestroyed && settled.isActive('figure', { mediaName: replaced })) {
                settled.chain().focus().updateFigure({ mediaName: result[0].name, width: null, height: null }).run();
            }
        },
        // The name a pasted image item is stored under: another document's file is re-uploaded into this
        // one's media/ first, and skipped if that fails rather than falling back to an unresolvable name.
        pastedMediaName: async (item: EigenClipboardImageItem): Promise<string | null> => {
            if (!needsReUpload(item.sourceParentId, mediaFolderId) || !mediaFolderId) return item.mediaName;
            const result = await reUploadImage(
                item.sourcePathId,
                item.sourceOwnerId,
                item.sourceMountId,
                mediaFolderId,
                uploadFile.mutateAsync,
                item.mediaName,
            );
            return result?.mediaName ?? null;
        },
    };
}

type DocMedia = ReturnType<typeof useDocMedia>;

// A note holds paragraphs, so a pasted heading, list or table lands as paragraphs.
const NoteDocument = Node.create({ name: 'doc', topNode: true, content: 'paragraph+' });

// A page-less doc has no pages to break, so Mod-Enter inserts no page break and no line break either, as in Google. In
// a code block it still leaves the block. Above the page break's own shortcut, which would insert one.
const noPageBreaksWhenPageless = (pageless: () => boolean) =>
    Extension.create({
        name: 'noPageBreaksWhenPageless',
        priority: 102,
        addKeyboardShortcuts() {
            return { 'Mod-Enter': () => pageless() && !this.editor.isActive('codeBlock') };
        },
    });

// A note has no history of its own: its edits forward into the body, whose undo takes them back and pulls the note
// back with them, so ⌘Z in a note and in the body walk one history.
const noteHistory = (body: () => Editor | null) =>
    Extension.create({
        name: 'noteHistory',
        // The body's undo pulls the note back while the command runs, so the note's own transaction would land on a
        // state it was not made from; Collaboration's undo prevents its dispatch the same way.
        addCommands: () => ({
            undo:
                () =>
                ({ tr, dispatch }) => {
                    tr.setMeta('preventDispatch', true);
                    return (dispatch ? body()?.commands.undo() : body()?.can().undo()) ?? false;
                },
            redo:
                () =>
                ({ tr, dispatch }) => {
                    tr.setMeta('preventDispatch', true);
                    return (dispatch ? body()?.commands.redo() : body()?.can().redo()) ?? false;
                },
        }),
        addKeyboardShortcuts() {
            return {
                'Mod-z': () => this.editor.commands.undo(),
                'Shift-Mod-z': () => this.editor.commands.redo(),
                'Mod-y': () => this.editor.commands.redo(),
            };
        },
    });

type DocEditorTarget =
    // The body: its undo manager over the content and the page, and the comment cards a pasted anchor may keep.
    | { undoManager: Y.UndoManager; cardIds: () => ReadonlySet<string> }
    // A band: its root, y-tiptap's own undo over it, no comments, and Esc to leave it. Esc is the band's own key, so
    // the find bar and a dialog, which hold focus, keep theirs.
    | { field: BandRoot; onLeave: () => void }
    // The open footnote's note: no root of its own, as the body's editor holds the note and the note's edits forward
    // into it. Its undo is the body's, comments don't reach it, and Esc leaves it.
    | { body: () => Editor | null; onLeave: () => void };

type DocEditorOptions = {
    yDoc: Y.Doc;
    editable: boolean;
    target: DocEditorTarget;
    caret: { provider: WebsocketProvider; user: { name: string; color: string; userId: string } } | null;
    // A column's border drags with a mouse only: prosemirror-tables reads mouse events, so a finger
    // drags nothing, and a tap beside a border would start a drag that swallows the caret.
    coarsePointer: boolean;
    figure?: Partial<FigureFrameOptions>;
    chart?: Partial<ChartOptions>;
    equation?: Partial<EquationOptions>;
    // A right-click in a cell, at `pos`: true when the host opened the table menu.
    table?: { onContextMenu: (editor: Editor, pos: number, event: MouseEvent) => boolean };
    footnote?: Partial<FootnoteOptions>;
    tableOfContents?: Partial<TableOfContentsOptions>;
    // An extension named as a schema node or mark takes its place, as the body's comment mark does.
    extensions?: Extensions;
    media: () => DocMedia;
    editor: () => Editor | null;
};

// What every docs editor is built from: the schema, a band's without BAND_EXCLUDED_NODES, the node views, the
// collaboration and the clipboard. useDocEditor builds it in a component; a test builds it on its own.
export function docEditorOptions({
    yDoc,
    editable,
    target,
    caret,
    coarsePointer,
    figure,
    chart,
    equation,
    table,
    footnote,
    tableOfContents,
    extensions = [],
    media,
    editor,
}: DocEditorOptions): UseEditorOptions {
    const band = 'field' in target;
    const note = 'body' in target;
    const cardIds = band || note ? () => NO_CARDS : target.cardIds;
    // The page map, not the page on screen: an update that changes the content and the page together reaches the
    // editor before React draws the new page. A band prints in the body's column. Tables and indents keep within it,
    // and a positioned figure on its paper.
    const page = () => pagePx(readPageSetup(yDoc.getMap(PAGE_ROOT).toJSON()));
    const textColumnWidth = () => {
        const { width, margin } = page();
        return width - margin.left - margin.right;
    };
    const paperWidth = () => page().width;
    const pageless = () => page().pageless;
    // The map, as the column: a step or a paste right after a peer's update of Normal text takes the new one. A note's
    // paragraphs draw at the footnote size, which its size box shows and a step steps from.
    const normalStyle = () => {
        const style = readNormalStyle(yDoc.getMap(STYLE_ROOT).toJSON());
        return note ? { ...style, size: FOOTNOTE_FONT_SIZE } : style;
    };
    const settle = note ? target.body : editor;
    const leave = (onLeave: () => void) =>
        Extension.create({
            name: 'leave',
            addKeyboardShortcuts: () => ({
                Escape: () => {
                    onLeave();
                    return true;
                },
            }),
        });
    return {
        editable,
        // y-tiptap writes nothing while the doc reads as one empty paragraph, unless an earlier update saw other content.
        // It draws the root as it builds its plugin view, before its update can see that. One update as the view mounts
        // shows it what the root holds, so an edit that empties a root that held something is saved.
        onMount: ({ editor }) => editor.view.updateState(editor.state),
        extensions: [
            // A note's own doc holds its paragraphs; its nested note stays in the schema, as a peer may write one.
            ...getDocExtensions({
                lowlight,
                textColumnWidth,
                normalStyle,
                remote: (tr) => !!tr.getMeta(ySyncPluginKey),
                exclude: [
                    ...(band ? BAND_EXCLUDED_NODES : []),
                    ...(band || note ? [] : ['footnote']),
                    'figure',
                    'chart',
                    'equation',
                    'table',
                    'pageNumber',
                    'tableOfContents',
                    ...extensions.map((extension) => extension.name),
                ],
            }).map((extension) =>
                note && extension.name === 'starterKit' ? extension.configure({ document: false }) : extension,
            ),
            ...(note ? [NoteDocument] : []),
            EditorTable.configure({ resizable: !coarsePointer, pageless, paperWidth }),
            Figure.configure(figure),
            ...(band ? [] : [Chart.configure(chart)]),
            Equation.configure(equation),
            PageNumber,
            ...(band ? [] : [TableOfContents.configure(tableOfContents)]),
            ...(band || note ? [] : [Footnote.configure(footnote), NoteFormatting]),
            TableWidthClamp.configure({ textColumnWidth, paperWidth, band }),
            noPageBreaksWhenPageless(pageless),
            PositionedFigures.configure({ page, band, note }),
            AtomMarks,
            ...extensions,
            ...(band ? [leave(target.onLeave)] : []),
            ...(note ? [leave(target.onLeave), NoteDecorations, noteHistory(target.body)] : []),
            ...(note
                ? []
                : [
                      Collaboration.configure(
                          band
                              ? { document: yDoc, field: target.field }
                              : { document: yDoc, yUndoOptions: { undoManager: target.undoManager } },
                      ),
                  ]),
            ...(caret && !note
                ? [
                      CollaborationCaret.configure({
                          provider: caret.provider,
                          // userId is what the server's awareness gate checks; without it every frame is dropped
                          user: caret.user,
                          render: (user: Record<string, string>) =>
                              renderPresenceCaret({ name: user.name, color: user.color }),
                      }),
                  ]
                : []),
        ],
        editorProps: {
            attributes: {
                class: band ? `eigen-prose ${DOC_PROSE_CLASS} ${PAGE_BAND_CLASS}` : `eigen-prose ${DOC_PROSE_CLASS}`,
            },
            handleDOMEvents: {
                copy: (view, event) => writeDocsClipboard(view, event, media().resolveMediaPath),
                cut: (view, event) => writeDocsClipboard(view, event, media().resolveMediaPath),
                // An editor prop, so it runs ahead of every plugin's: the table menu takes in the comment mark's rows
                // and the selection's Add comment, which would otherwise open their own menus over a cell.
                contextmenu: (view, event) => {
                    const target = editor();
                    const pos = cellPosAt(view, event);
                    if (!table || !target || pos === null || !table.onContextMenu(target, pos, event)) return false;
                    event.preventDefault();
                    return true;
                },
            },
            transformPastedHTML: (html: string) => cleanPastedHTML(html, page(), cardIds(), normalStyle().font, !band),
            // A note pasted into a note is nested in it: its text stays, in its place.
            transformPasted: note
                ? (slice, view) =>
                      Slice.fromJSON(view.state.schema, {
                          ...slice.toJSON(),
                          content: flattenNestedFootnotes({ type: 'footnote', content: slice.content.toJSON() })
                              .content,
                      })
                : undefined,
            handleDrop: (view, event) => {
                if (!event.dataTransfer) return false;
                const files = Array.from(event.dataTransfer.files);
                const imageFile = files.find((f) => f.type.startsWith('image/'));
                if (imageFile && media().mediaFolderId && editor()) {
                    event.preventDefault();
                    const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
                    if (dropPos) {
                        const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(dropPos.pos)));
                        view.dispatch(tr);
                    }
                    media()
                        .uploadImage(editor, imageFile, settle)
                        .catch(() => {});
                    return true;
                }
                return false;
            },
            handlePaste: (_view, event) => {
                const target = editor();
                if (!event.clipboardData || !target) return false;
                const paste = classifyPaste(event.clipboardData);
                const { mediaFolderId, uploadSvg, uploadImage, pastedMediaName } = media();

                if (paste.svg && mediaFolderId) {
                    event.preventDefault();
                    uploadSvg(editor, paste.svg, settle).catch(() => {});
                    return true;
                }

                if (paste.eigen) {
                    // Images and charts take this path, images for the cross-mount re-upload, a docs copy's
                    // through its own HTML; text only when text/html is marker-only (a canvas text copy), so a
                    // sheets table still parses in PM. Claimed only with an item this editor can place, or ⌘V
                    // on a bare `elements` item is dead. A band and a note place no chart, as their Insert
                    // menus offer none.
                    const items =
                        band || note ? paste.eigen.items.filter((i) => i.type !== 'chart') : paste.eigen.items;
                    const hasAtom = items.some((i) => i.type === 'image' || i.type === 'chart');
                    const hasText = items.some((i) => i.type === 'text' && clipboardTextItemHasContent(i));
                    if (hasAtom || (hasText && !hasRichHtmlBeyondMarker(event.clipboardData))) {
                        event.preventDefault();
                        insertEigenItems(target, items, paste.html, pastedMediaName, textColumnWidth()).catch(() => {});
                        return true;
                    }
                }

                const imageFile = paste.imageFiles[0];
                if (imageFile && mediaFolderId) {
                    event.preventDefault();
                    uploadImage(editor, imageFile, settle).catch(() => {});
                    return true;
                }
                return false;
            },
        },
    };
}

// What useDocEditor takes: docEditorOptions' less what it fills in itself, the doc's media and the provider.
// `editable` is this tab's write access.
type UseDocEditorOptions = Omit<DocEditorOptions, 'caret' | 'coarsePointer' | 'media' | 'editor'> & {
    media: DocMedia;
    // Null draws and sets no caret.
    provider: WebsocketProvider | null;
    // False keeps a writer's editor read-only too: a band's, while another band or the body is being edited.
    editing?: boolean;
};

// The body's editor, each band's and the open note's: docEditorOptions with this tab's user and its pointer, plus the sweep of pending
// images a closed tab left and the font-name pass, both in an editable editor only.
export function useDocEditor(
    { media, provider, editing = true, ...options }: UseDocEditorOptions,
    deps: DependencyList = [],
): Editor {
    const auth = useAuth();
    const coarsePointer = useIsCoarsePointer();
    const mediaRef = useRef(media);
    mediaRef.current = media;
    const editorRef = useRef<Editor | null>(null);
    const user = auth.user;
    const editable = options.editable && editing;
    const editor = useEditor(
        docEditorOptions({
            ...options,
            editable,
            caret:
                provider && user
                    ? { provider, user: { name: user.name, color: userColor(user.id), userId: user.id } }
                    : null,
            coarsePointer,
            media: () => mediaRef.current,
            editor: () => editorRef.current,
        }),
        deps,
    );
    editorRef.current = editor;
    // TipTap keeps an editor's editable flag across renders, so write access lost or gained while the doc is open, and a
    // band entered or left, reach it here. Before paint, so an editor never shows a frame editable after it lost that.
    useLayoutEffect(() => {
        editor.setEditable(editable, false);
        // A node view reads the flag as it renders and nothing re-renders it, so a selected image would keep its grips.
        const { selection } = editor.state;
        if (!editable && selection instanceof NodeSelection) {
            editor.view.dispatch(editor.state.tr.setSelection(Selection.near(selection.$from)));
        }
    }, [editor, editable]);
    // A note's images and fonts are the body's, which sweeps and collapses them.
    const sweeps = options.editable && !('body' in options.target);

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload. Snapshot the pending
    // figure mediaNames; a completed upload has swapped the name, so the stale name no longer matches.
    // A viewer's deletion would be dropped by the server.
    useZombieMediaSweep({
        ready: sweeps,
        scan: () => {
            const names: string[] = [];
            editor.state.doc.descendants((node) => {
                if (
                    node.type.name === 'figure' &&
                    typeof node.attrs.mediaName === 'string' &&
                    isPendingMediaName(node.attrs.mediaName)
                ) {
                    names.push(node.attrs.mediaName);
                }
                return true;
            });
            return names;
        },
        remove: (names) => {
            for (const name of names) swapFigureMediaName(editor, name, null);
        },
    });

    // One-shot: collapse any legacy full-stack fontFamily marks to their EIGEN_FONTS name once the
    // synced doc is open for editing. The parent gates this subtree on first sync, so the content is
    // present at mount; idempotent, so a canWrite flip re-running it is a no-op.
    useEffect(() => {
        if (!sweeps) return;
        normalizeFontFamilyMarks(editor);
    }, [editor, sweeps]);

    return editor;
}

// The four bands' editors, kept as long as the doc is open and all on the page, hidden or not: an editor binds to its
// root once its view mounts, and a preset numbers a band the page doesn't show, an upload settles after its band was
// left.
// Only the band being edited is editable; the others draw as they print.
export function useBandEditors({
    editing,
    onLeave,
    ...options
}: Omit<UseDocEditorOptions, 'target' | 'editing'> & {
    editing: BandRoot | null;
    onLeave: () => void;
}): Record<BandRoot, Editor> {
    // The keymap keeps the handler its editor was built with.
    const onLeaveRef = useRef(onLeave);
    onLeaveRef.current = onLeave;
    const leave = () => onLeaveRef.current();
    const band = (field: BandRoot) => ({ ...options, editing: field === editing, target: { field, onLeave: leave } });
    return {
        header: useDocEditor(band('header')),
        footer: useDocEditor(band('footer')),
        headerFirst: useDocEditor(band('headerFirst')),
        footerFirst: useDocEditor(band('footerFirst')),
    };
}
