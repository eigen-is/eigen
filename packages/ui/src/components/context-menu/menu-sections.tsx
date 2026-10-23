// The one order every context and ⋮ menu draws its rows in (docs/LAYOUT.md § Menus draw their rows in one order). A
// host passes each row to the group it belongs to; the order lives here, so no menu can drift from it.

import { Fragment, type ReactNode } from 'react';
import { DropdownMenuSeparator } from '../dropdown-menu';

const SECTIONS = [
    // The verb the menu was opened for: Open, Open in new tab, Quick preview, View comment, Reply, Forward.
    'open',
    // Cut, Copy, Paste, in that order: ClipboardMenuItems.
    'clipboard',
    // Object actions that make or change the object: New slide, Insert, Duplicate, Edit, Rename.
    'create',
    // Move to, Copy to, Archive, labels, color, assign, resolve, hide, sort, filter.
    'organize',
    // A canvas object's Order ▸, a sheet tab's Move left and right.
    'arrange',
    // Convert to shapes, Convert to Sheet, Document or Slides.
    'convert',
    // What takes the object out: Download, Export, Print, Save to Drive, Import to….
    'output',
    // What involves other people: Add comment, Share ▸, Watch.
    'collaborate',
    // Delete, Move to trash, Remove…: last, alone, each row `variant="destructive"`.
    'destructive',
] as const;

export type MenuSectionsProps = Partial<Record<(typeof SECTIONS)[number], ReactNode>>;

// A group whose rows all render nothing still leaves its separator; DropdownMenuSeparator hides itself when it
// opens or ends the menu or follows another, so the host needs no separator logic of its own.
export function MenuSections(props: MenuSectionsProps) {
    return SECTIONS.filter((section) => props[section]).map((section, i) => (
        <Fragment key={section}>
            {i > 0 && <DropdownMenuSeparator />}
            {props[section]}
        </Fragment>
    ));
}
