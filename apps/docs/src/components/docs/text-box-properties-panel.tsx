// The Docs Text box panel for the selected text box: its size, where it sits on the page, its fill and outline, the
// padding around its text, the text's vertical alignment and rounded corners. It shares the Image panel's size and
// layout sections, and every write keeps the box selected so the panel stays open.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { CellBorderStyle, TextBoxEdit, TextBoxVerticalAlign } from '@workspace/lib/docs/eigendoc';
import {
    CELL_BORDER_STYLES,
    cellBorderValue,
    figurePlacement,
    MAX_CELL_BORDER_PX,
    MIN_CELL_BORDER_PX,
    readCellBackground,
    readTextBoxAttrs,
    TEXT_BOX_DEFAULT_OUTLINE,
    textBoxPadding,
} from '@workspace/lib/docs/eigendoc';
import {
    ColorRow,
    PropertiesPanel,
    PropertyCheckbox,
    PropertyNumberInput,
    PropertyRow,
    PropertySection,
    PropertyToggle,
} from '@workspace/ui/components/properties-panel';
import type { LucideIcon } from 'lucide-react';
import { AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { figureMaxWidth } from './extensions/figure-frame';
import { selectionDrawsInLine } from './extensions/positioned-figure';
import { fitTextBoxHeight, fitTextBoxWidth, setTextBoxLayout } from './extensions/text-box';
import { CmField, FigureLayoutSection, FigureSizeSection } from './figure-properties-panel';

const VERTICAL_ALIGN_LOOK: { align: TextBoxVerticalAlign; label: string; icon: LucideIcon }[] = [
    { align: 'top', label: 'Top', icon: AlignVerticalJustifyStart },
    { align: 'middle', label: 'Middle', icon: AlignVerticalJustifyCenter },
    { align: 'bottom', label: 'Bottom', icon: AlignVerticalJustifyEnd },
];

const OUTLINE_STYLE_LABELS: Record<CellBorderStyle, string> = {
    solid: 'Solid',
    dashed: 'Dashed',
    dotted: 'Dotted',
    double: 'Double',
};

export function TextBoxPropertiesPanel({ editor }: { editor: Editor }) {
    // useEditor re-renders on no transaction, and a write that keeps the box selected fires no selectionUpdate.
    const look = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = readTextBoxAttrs(e.getAttributes('textBox'));
            const padding = textBoxPadding(attrs);
            return {
                width: attrs.width,
                height: attrs.height,
                auto: attrs.height === null,
                ...figurePlacement(attrs),
                fill: attrs.fill ?? '',
                pen: attrs.outline === 'none' ? null : attrs.outline,
                paddingX: padding.x,
                paddingY: padding.y,
                verticalAlign: attrs.verticalAlign ?? 'top',
                rounded: attrs.rounded,
                inFlowOnly: selectionDrawsInLine(e),
            };
        },
    });
    // An auto box is as tall as its text, which only its drawn box knows. That changes after the render a write causes,
    // and with no write at all as an image in it loads, so the panel watches the box: its border box, which alone
    // changes with its padding or its line.
    const drawnBox = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const dom = e.view.nodeDOM(e.state.selection.from);
            return dom instanceof Element ? dom.querySelector<HTMLElement>('.text-box') : null;
        },
        equalityFn: Object.is,
    });
    const [drawnHeight, setDrawnHeight] = useState<number>();
    useLayoutEffect(() => {
        if (!drawnBox) return;
        setDrawnHeight(drawnBox.offsetHeight);
        const observer = new ResizeObserver(() => setDrawnHeight(drawnBox.offsetHeight));
        observer.observe(drawnBox, { box: 'border-box' });
        return () => observer.disconnect();
    }, [drawnBox]);
    const height = look.height ?? drawnHeight;
    const write = (attributes: TextBoxEdit) => editor.commands.updateTextBox(attributes);
    // A box with no line takes the line a new box has, with the change.
    const outline = (change: Partial<{ width: number; style: CellBorderStyle; color: string }>) =>
        write({ outline: cellBorderValue({ ...(look.pen ?? TEXT_BOX_DEFAULT_OUTLINE), ...change }) });

    return (
        <PropertiesPanel title="Text box">
            <FigureSizeSection
                width={look.width}
                height={height}
                autoHeight={{ auto: look.auto, onAutoChange: (auto) => write({ height: auto ? null : height }) }}
                onChange={(size) =>
                    write({
                        ...(size.width !== undefined && {
                            width: fitTextBoxWidth(size.width, figureMaxWidth(editor, look.layout)),
                        }),
                        ...(size.height !== undefined && { height: fitTextBoxHeight(size.height) }),
                    })
                }
            />

            <FigureLayoutSection
                layout={look.layout}
                alignment={look.alignment}
                inFlowOnly={look.inFlowOnly}
                onChange={(attributes) => setTextBoxLayout(editor, attributes)}
            />

            <PropertySection title="Box">
                {/* None writes the transparent token, which reads as no fill. */}
                <ColorRow
                    label="Fill"
                    value={look.fill}
                    allowNone
                    onChange={(color) => write({ fill: readCellBackground(color) })}
                />
                <PropertyCheckbox
                    label="Rounded corners"
                    checked={look.rounded}
                    onCheckedChange={(rounded) => write({ rounded })}
                />
                <ColorRow
                    label="Outline"
                    value={look.pen?.color ?? ''}
                    allowNone
                    onChange={(color) => {
                        const hex = readCellBackground(color);
                        if (hex) outline({ color: hex });
                        else write({ outline: null });
                    }}
                />
                {look.pen && (
                    <>
                        <PropertyRow label="Weight">
                            <PropertyNumberInput
                                value={look.pen.width}
                                min={MIN_CELL_BORDER_PX}
                                max={MAX_CELL_BORDER_PX}
                                step={0.5}
                                onChange={(width) => outline({ width })}
                            />
                        </PropertyRow>
                        <PropertyRow label="Style">
                            <div className="flex flex-wrap items-center gap-1">
                                {CELL_BORDER_STYLES.map((style) => (
                                    <PropertyToggle
                                        key={style}
                                        className="w-auto px-2 text-xs"
                                        pressed={look.pen?.style === style}
                                        onPressedChange={() => outline({ style })}
                                    >
                                        {OUTLINE_STYLE_LABELS[style]}
                                    </PropertyToggle>
                                ))}
                            </div>
                        </PropertyRow>
                    </>
                )}
            </PropertySection>

            <PropertySection title="Text">
                {/* A row's label holds about eight characters, and "Horizontal" would be cut short. */}
                <PropertyRow label="Horiz.">
                    <CmField px={look.paddingX} onCommit={(px) => write({ paddingX: px })} />
                </PropertyRow>
                <PropertyRow label="Vert.">
                    <CmField px={look.paddingY} onCommit={(px) => write({ paddingY: px })} />
                </PropertyRow>
                <PropertyRow label="Align">
                    <div className="flex items-center gap-1">
                        {VERTICAL_ALIGN_LOOK.map(({ align, label, icon: Icon }) => (
                            <PropertyToggle
                                key={align}
                                aria-label={label}
                                title={label}
                                pressed={look.verticalAlign === align}
                                onPressedChange={() => write({ verticalAlign: align === 'top' ? null : align })}
                            >
                                <Icon className="h-4 w-4" />
                            </PropertyToggle>
                        ))}
                    </div>
                </PropertyRow>
            </PropertySection>
        </PropertiesPanel>
    );
}
