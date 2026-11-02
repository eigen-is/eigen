// The command palette's shared types: a command and the context it runs with, what a page publishes
// as its selection and the rows bound to it, and the results the sources hand the engine to merge.

import type { LucideIcon } from 'lucide-react';
import type { ContactSuggestion } from './contact';
import type {
    DocCommentMatch,
    DocCommentSearch,
    DocSearchController,
    DocSearchMatch,
    DocSearchSession,
} from './doc-search';
import type { DrivePath, EigenDocType, ExportFormat } from './drive';
import type { DriveActionGroup } from './drive-actions';
import type { FileActionGroup } from './file-subject';
import type { EmailSummary } from './mail';
import type { HelpSearchDoc } from './search';

export type PaletteScope = 'mail' | 'file' | 'doc' | 'actions' | 'contacts' | 'help';

type ResultGroup =
    | 'top-hit'
    | 'suggested'
    | 'smart'
    | 'selection'
    | 'doc-content'
    | 'doc-comments'
    | 'mail'
    | 'file'
    | 'contacts'
    | 'help'
    | 'actions';

// What a page has selected: Drive's selected rows, or the open document as a one-item selection.
export type PaletteSelection = { items: readonly DrivePath[] } | null;

// One row a page offers for its selection, already bound to those items: the menu row it draws, whose
// label and icon the palette shows, and the run that performs it. The row's menu group orders the
// palette's rows as the menu orders them. Download as names its format.
export type PaletteSelectionAction = {
    action: {
        id: string;
        label: string;
        pluralLabel?: string;
        icon: LucideIcon;
        group: DriveActionGroup | FileActionGroup;
    };
    run: (format?: ExportFormat) => void;
};

// The rows a page publishes with its selection, such as Drive's item menu or an open document's File menu.
export type PaletteSelectionActions = readonly PaletteSelectionAction[] | null;

// What a command's handler receives: navigation that knows which app it runs in, and the helpers the
// commands need for their side effects. A helper is added here once a command needs it.
export type CommandContext = {
    ownerId: string;
    // False on a server without hosted mail. Every command and source that leads into Mail checks it, so
    // no palette row leads into an app that isn't there.
    mailEnabled: boolean;
    selection: PaletteSelection;
    selectionActions: PaletteSelectionActions;
    // The open document's search controller, which DocSearchProvider publishes. It is null where no
    // document is open, such as in Drive. The palette's doc: scope searches through it, and Enter opens
    // the find bar.
    docSearch: DocSearchController | null;
    // The find bar's session in DocSearchProvider. Picking an In document hit hands it the query and
    // shows the match there. It is null when no document is open.
    docSearchSession: DocSearchSession | null;
    // The search through the open document's comment threads, null when no document publishes one.
    docCommentSearch: DocCommentSearch;
    navigate: (to: string) => void;
    openDriveCreate: (kind: EigenDocType | 'folder') => void;
    openMailComposeWith: (opts: { to?: string; attachments?: readonly DrivePath[] }) => void;
    openPreview: (path: DrivePath) => void;
    toggleTheme: () => void;
};

// A catalog entry. The engine wraps these into a `PaletteResult` of kind 'action' after applying
// availability and boosts. `group: 'selection'` marks a command built from the rows a page published:
// it renders in the "Selection" section instead of the catalog's "Actions" section, and its subtitle
// names the selected item.
export type Command = {
    id: string;
    title: string;
    subtitle?: string;
    keywords?: string[];
    icon: LucideIcon;
    baseRank?: number;
    group?: 'actions' | 'selection';
    availability?: (ctx: CommandContext) => boolean;
    run: (ctx: CommandContext) => void;
};

export type PaletteResult =
    | {
          kind: 'action';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'smart';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          run: (ctx: CommandContext) => void;
          deterministic?: boolean;
      }
    | {
          kind: 'contact';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: ContactSuggestion;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'mail';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: EmailSummary;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'file';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: DrivePath;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'help';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: HelpSearchDoc;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'doc-hit';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: DocSearchMatch;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'doc-comment-hit';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: DocCommentMatch;
          run: (ctx: CommandContext) => void;
      };

export type Sections = {
    topHit?: PaletteResult;
    groups: { id: Exclude<ResultGroup, 'top-hit'>; heading: string; items: PaletteResult[] }[];
};
