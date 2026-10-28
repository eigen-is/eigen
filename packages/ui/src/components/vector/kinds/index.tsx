// The React half of the element registry. `packages/lib`'s ELEMENT_KINDS answers what a kind IS — its
// fields, geometry, paint and search text; this answers how a kind is PRESENTED: the icon and label
// every surface shows, the tool shortcut, the dialog a kind opens when it is edited on the canvas, and
// the panel rows the generic capability rows do not cover. Text is edited in place for every kind that
// holds it, so rich-text.tsx owns that editor and no kind names one.
// Adding a kind = one entry here and one in lib; TypeScript forces both.

import type { LetterKey, NumberKey } from '@tanstack/react-hotkeys';
import type { NewVectorElement, VectorElement, VectorElementPatch, VectorElementType } from '@workspace/lib/vector';
import type { LucideIcon } from 'lucide-react';
import {
    ChartColumn,
    ChartPie,
    Circle,
    Diamond,
    Image as ImageIcon,
    Minus,
    MoveUpRight,
    Pencil,
    Spline,
    Square,
    Type,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ArrowPanelSection } from './arrow';
import { ChartEditDialog, ChartPanelSection } from './chart';
import { ImagePanelSection } from './image';

// Mounted inside the element's own layer while its text is being edited on the canvas. `onChange` writes
// straight through (unsealed, so keystrokes coalesce into one undo step); `onExit` ends the session.
export type InPlaceEditorProps = {
    element: VectorElement;
    onChange: (fields: VectorElementPatch) => void;
    onExit: () => void;
};

// Rows for a homogeneous selection of this kind. `onChange` applies ONE patch to every selected element
// and `onChangeEach` a patch computed per element (a label's measured width, an arrow's re-docked
// route), each in one sealed transact (the panel owns the sealing). `scene` resolves an element the
// selection does not hold — an arrow's bound shape. `onReplace` swaps a sole selected element for new ones
// and selects them, one undo step (a chart's Convert to shapes). `slideWidth` is the deck's, for its pt; a drawing has none.
export type KindPanelSectionProps = {
    elements: VectorElement[];
    scene: Map<string, VectorElement>;
    slideWidth?: number;
    onChange: (fields: VectorElementPatch) => void;
    onChangeEach: (patch: (el: VectorElement) => VectorElementPatch) => void;
    onReplace: (elements: NewVectorElement[]) => void;
};

// What a double-click opens for a kind edited in a dialog rather than in place (a chart's data).
// `onChange` is one sealed write; `onClose` ends it, saved or not.
export type KindEditDialogProps = {
    element: VectorElement;
    onChange: (fields: VectorElementPatch) => void;
    onClose: () => void;
};

type ElementKindUi = {
    icon: LucideIcon;
    label: string;
    // Present exactly on the kinds a tool can create; an image arrives by upload, so it has none.
    // Letters are Excalidraw's; `digit` is the same tool on the number row.
    shortcut?: { letter: LetterKey; digit: NumberKey };
    EditDialog?: ComponentType<KindEditDialogProps>;
    PanelSection?: ComponentType<KindPanelSectionProps>;
};

export const ELEMENT_KIND_UI: Record<VectorElementType, ElementKindUi> = {
    rectangle: { icon: Square, label: 'Rectangle', shortcut: { letter: 'R', digit: '2' } },
    diamond: { icon: Diamond, label: 'Diamond', shortcut: { letter: 'D', digit: '3' } },
    ellipse: { icon: Circle, label: 'Ellipse', shortcut: { letter: 'O', digit: '4' } },
    pie: { icon: ChartPie, label: 'Pie' },
    path: { icon: Spline, label: 'Freeform' },
    chart: { icon: ChartColumn, label: 'Chart', EditDialog: ChartEditDialog, PanelSection: ChartPanelSection },
    arrow: {
        icon: MoveUpRight,
        label: 'Arrow',
        shortcut: { letter: 'A', digit: '5' },
        PanelSection: ArrowPanelSection,
    },
    line: { icon: Minus, label: 'Line', shortcut: { letter: 'L', digit: '6' } },
    freedraw: { icon: Pencil, label: 'Draw', shortcut: { letter: 'P', digit: '7' } },
    richtext: { icon: Type, label: 'Text', shortcut: { letter: 'T', digit: '8' } },
    image: { icon: ImageIcon, label: 'Image', PanelSection: ImagePanelSection },
};
