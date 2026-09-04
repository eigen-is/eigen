// The React half of the element registry. `packages/lib`'s ELEMENT_KINDS answers what a kind IS — its
// fields, geometry, paint and search text; this answers how a kind is PRESENTED: the icon and label
// every surface shows, the tool shortcut, the in-place editor a kind mounts when it is edited on the
// canvas, and the panel rows the generic capability rows do not cover. Adding a kind = one entry here
// and one in lib; TypeScript forces both.

import type { LetterKey, NumberKey } from '@tanstack/react-hotkeys';
import type { VectorElement, VectorElementType } from '@workspace/lib/vector';
import {
    Circle,
    Diamond,
    Image as ImageIcon,
    type LucideIcon,
    Minus,
    MoveUpRight,
    Pencil,
    Square,
    Type,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { VectorElementPatch } from '../hooks/use-canvas-doc';
import { ArrowPanelSection } from './arrow';
import { ImagePanelSection } from './image';
import { RichTextInPlaceEditor, RichTextPanelSection } from './richtext';

// Mounted inside the element's own layer while it is being edited on the canvas. `onChange` writes
// straight through (unsealed, so keystrokes coalesce into one undo step); `onExit` ends the session.
export type InPlaceEditorProps = {
    element: VectorElement;
    onChange: (fields: VectorElementPatch) => void;
    onExit: () => void;
};

// Rows for a homogeneous selection of this kind. `onChange` applies ONE patch to every selected element
// and `onChangeEach` a patch computed per element (a label's measured width, an arrow's re-docked
// route), each in one sealed transact (the panel owns the sealing). `scene` resolves an element the
// selection does not hold — an arrow's bound shape.
export type KindPanelSectionProps = {
    elements: VectorElement[];
    scene: Map<string, VectorElement>;
    onChange: (fields: VectorElementPatch) => void;
    onChangeEach: (patch: (el: VectorElement) => VectorElementPatch) => void;
};

type ElementKindUi = {
    icon: LucideIcon;
    label: string;
    // Present exactly on the kinds a tool can create; an image arrives by upload, so it has none.
    // Letters are Excalidraw's; `digit` is the same tool on the number row.
    shortcut?: { letter: LetterKey; digit: NumberKey };
    InPlaceEditor?: ComponentType<InPlaceEditorProps>;
    PanelSection?: ComponentType<KindPanelSectionProps>;
};

export const ELEMENT_KIND_UI: Record<VectorElementType, ElementKindUi> = {
    rectangle: { icon: Square, label: 'Rectangle', shortcut: { letter: 'R', digit: '2' } },
    diamond: { icon: Diamond, label: 'Diamond', shortcut: { letter: 'D', digit: '3' } },
    ellipse: { icon: Circle, label: 'Ellipse', shortcut: { letter: 'O', digit: '4' } },
    arrow: {
        icon: MoveUpRight,
        label: 'Arrow',
        shortcut: { letter: 'A', digit: '5' },
        PanelSection: ArrowPanelSection,
    },
    line: { icon: Minus, label: 'Line', shortcut: { letter: 'L', digit: '6' } },
    freedraw: { icon: Pencil, label: 'Draw', shortcut: { letter: 'P', digit: '7' } },
    richtext: {
        icon: Type,
        label: 'Text',
        shortcut: { letter: 'T', digit: '8' },
        InPlaceEditor: RichTextInPlaceEditor,
        PanelSection: RichTextPanelSection,
    },
    image: { icon: ImageIcon, label: 'Image', PanelSection: ImagePanelSection },
};
