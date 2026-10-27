// Quick-format controls mirrored from the docs toolbar, driving the same handlers as the Format menu:
// an extra surface, not a replacement. The menu bar's 1fr·auto·1fr grid centers it on the bar. The
// bar's 1360px container query hides it, as read-only does, below the width where it still sits centered.

import { nextFontSize } from '@workspace/lib/constants/fonts';
import { cellFontName, SHEET_DEFAULT_FONT } from '@workspace/lib/sheets';
import { ToolbarSeparator, TooltipButton } from '@workspace/ui';
import { ColorPickerButton, FontSizeStepper } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { AlignCenter, AlignLeft, AlignRight, Baseline, Bold, Highlighter, Italic } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useCellEditorRefocus } from '../../hooks/useCellEditorRefocus';
import { useEditorSelectionStyle } from '../../hooks/useEditorSelectionStyle';
import {
    handleBold,
    handleFont,
    handleHorizontalAlign,
    handleItalic,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
} from '../../state';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';

export function FormatToolbar() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    // Reflect the anchor cell so the swatches + active alignment track the selection, and while a cell
    // is open the run at its caret, the way the docs toolbar follows the caret.
    const cell = useAnchorCell();
    const caret = useEditorSelectionStyle();
    const refocusCellEditor = useCellEditorRefocus();

    if (!context.allowEdit) return null;

    // `ht` is stored as '1'/'0'/'2' by the align handler but as a number on
    // defaults/imports — coerce before comparing.
    const textColor = caret?.fc ?? cell?.fc ?? '';
    const fillColor = cell?.bg ?? '';
    const align = cell?.ht == null ? undefined : Number(cell.ht); // 0 = center, 1 = left, 2 = right
    const fontName = caret?.ff ?? cellFontName(cell?.ff) ?? SHEET_DEFAULT_FONT.name;
    const fontSize = caret?.fs ?? (Number(cell?.fs) || settings.defaultFontSize);
    const bold = (caret?.bl ?? Number(cell?.bl)) === 1;
    const italic = (caret?.it ?? Number(cell?.it)) === 1;
    const setFontSize = (size: number) => {
        setContext((ctx) => {
            const input = refs.cellInput.current;
            if (input) handleTextSize(ctx, input, size, refs.canvas.current?.getContext('2d') ?? undefined);
        });
    };

    return (
        <div className="hidden @[1360px]:flex items-center gap-0.5">
            <FontPicker
                value={fontName}
                onCloseAutoFocus={refocusCellEditor}
                onChange={(name) => {
                    setContext((ctx) => {
                        handleFont(ctx, refs.cellInput.current!, name);
                    });
                }}
            />

            <ToolbarSeparator />

            {/* The size box hands the focus back as it blurs on Enter or Escape, with nowhere else to go. */}
            <div
                onBlur={(e) => {
                    if (!e.relatedTarget) refocusCellEditor(e.nativeEvent);
                }}
            >
                <FontSizeStepper
                    value={fontSize}
                    onChange={setFontSize}
                    onStep={(by) => setFontSize(nextFontSize(fontSize, by))}
                />
            </div>

            <ToolbarSeparator />

            <TooltipButton
                icon={Bold}
                tooltipText="Bold"
                active={bold}
                preventFocusLoss
                onClick={() => {
                    setContext((ctx) => {
                        handleBold(ctx, refs.cellInput.current!);
                    });
                }}
            />
            <TooltipButton
                icon={Italic}
                tooltipText="Italic"
                active={italic}
                preventFocusLoss
                onClick={() => {
                    setContext((ctx) => {
                        handleItalic(ctx, refs.cellInput.current!);
                    });
                }}
            />

            <ToolbarSeparator />

            <ColorPickerButton
                icon={Baseline}
                tooltipText="Text color"
                value={textColor}
                resetLabel="Default"
                showSwatch
                popoverClassName="sheet-mousedown-cancel"
                onCloseAutoFocus={refocusCellEditor}
                onChange={(color) => {
                    setContext((ctx) => {
                        handleTextColor(ctx, refs.cellInput.current!, color);
                    });
                }}
            />

            <ColorPickerButton
                icon={Highlighter}
                tooltipText="Fill color"
                value={fillColor}
                resetLabel="Default"
                showSwatch
                popoverClassName="sheet-mousedown-cancel"
                onCloseAutoFocus={refocusCellEditor}
                onChange={(color) => {
                    setContext((ctx) => {
                        handleTextBackground(ctx, refs.cellInput.current!, color);
                    });
                }}
            />

            <ToolbarSeparator />

            <TooltipButton
                icon={AlignLeft}
                tooltipText="Align left"
                active={align === 1}
                preventFocusLoss
                onClick={() => {
                    setContext((ctx) => {
                        handleHorizontalAlign(ctx, refs.cellInput.current!, 'left');
                    });
                }}
            />
            <TooltipButton
                icon={AlignCenter}
                tooltipText="Align center"
                active={align === 0}
                preventFocusLoss
                onClick={() => {
                    setContext((ctx) => {
                        handleHorizontalAlign(ctx, refs.cellInput.current!, 'center');
                    });
                }}
            />
            <TooltipButton
                icon={AlignRight}
                tooltipText="Align right"
                active={align === 2}
                preventFocusLoss
                onClick={() => {
                    setContext((ctx) => {
                        handleHorizontalAlign(ctx, refs.cellInput.current!, 'right');
                    });
                }}
            />
        </div>
    );
}
