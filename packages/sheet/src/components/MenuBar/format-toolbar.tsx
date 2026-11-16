// The workbook bar's format icon row, modeled on the docs toolbar: the font, bold, the colors and the alignment.
// It drives the same handlers as the Format menu and replaces none of it, so every icon it folds away on a narrow bar
// is still a row of that menu. A viewer gets no icon row.

import { nextFontSize } from '@workspace/lib/constants/fonts';
import { ToolbarSeparator, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { ColorPickerButton, FontSizeStepper } from '@workspace/ui/components/media';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { AlignCenter, AlignLeft, AlignRight, Baseline, Bold, Highlighter, Italic } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useCellEditorRefocus } from '../../hooks/useCellEditorRefocus';
import type { RunStyle } from '../../state';
import {
    HORIZONTAL_ALIGNS,
    handleBold,
    handleFont,
    handleHorizontalAlign,
    handleItalic,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
    runStyleOf,
} from '../../state';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { useFormatCells } from './use-format-cells';

// The controls show the anchor cell's colors, font and alignment. While a cell is open, they show the
// run at its `caret` instead, as the docs toolbar does.
export function FormatToolbar({ caret }: { caret: RunStyle | null }) {
    const { context } = useContext(WorkbookContext);
    const cell = useAnchorCell();
    const refocusCellEditor = useCellEditorRefocus();
    const format = useFormatCells();

    if (!context.allowEdit) return null;

    const textColor = caret?.fc ?? cell?.fc ?? '';
    const fillColor = cell?.bg ?? '';
    const align = cell?.ht == null ? undefined : HORIZONTAL_ALIGNS[cell.ht];
    const { ff: fontName, fs: fontSize, bl, it } = caret ?? runStyleOf(cell);
    const setFontSize = (size: number) => format((ctx, input) => handleTextSize(ctx, input, size));

    // The row folds from its right end as the bar narrows, as the Docs bar does, so its order is its priority order.
    // Each breakpoint is the bar width at which a part fits beside the menus, measured with the font picker showing
    // its widest font.
    return (
        <div className="hidden @[1000px]:flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
            <FontPicker
                value={fontName}
                onCloseAutoFocus={refocusCellEditor}
                onChange={(name) => format((ctx, input) => handleFont(ctx, input, name))}
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
                active={bl === 1}
                preventFocusLoss
                onClick={() => format(handleBold)}
            />
            <TooltipButton
                icon={Italic}
                tooltipText="Italic"
                active={it === 1}
                preventFocusLoss
                onClick={() => format(handleItalic)}
            />

            <div className="hidden @[1080px]:flex items-center gap-0.5">
                <ToolbarSeparator />

                <ColorPickerButton
                    icon={Baseline}
                    tooltipText="Text color"
                    value={textColor}
                    resetLabel="Default"
                    showSwatch
                    popoverClassName="sheet-mousedown-cancel"
                    onCloseAutoFocus={refocusCellEditor}
                    onChange={(color) => format((ctx, input) => handleTextColor(ctx, input, color))}
                />

                <ColorPickerButton
                    icon={Highlighter}
                    tooltipText="Fill color"
                    value={fillColor}
                    resetLabel="Default"
                    showSwatch
                    popoverClassName="sheet-mousedown-cancel"
                    onCloseAutoFocus={refocusCellEditor}
                    onChange={(color) => format((ctx, input) => handleTextBackground(ctx, input, color))}
                />
            </div>

            <div className="hidden @[1190px]:flex items-center gap-0.5">
                <ToolbarSeparator />

                <TooltipButton
                    icon={AlignLeft}
                    tooltipText="Align left"
                    active={align === 'left'}
                    preventFocusLoss
                    onClick={() => format((ctx, input) => handleHorizontalAlign(ctx, input, 'left'))}
                />
                <TooltipButton
                    icon={AlignCenter}
                    tooltipText="Align center"
                    active={align === 'center'}
                    preventFocusLoss
                    onClick={() => format((ctx, input) => handleHorizontalAlign(ctx, input, 'center'))}
                />
                <TooltipButton
                    icon={AlignRight}
                    tooltipText="Align right"
                    active={align === 'right'}
                    preventFocusLoss
                    onClick={() => format((ctx, input) => handleHorizontalAlign(ctx, input, 'right'))}
                />
            </div>
        </div>
    );
}
