import { useMediaQuery } from '@workspace/lib/media';
import { ToolbarSeparator } from '@workspace/ui/components/layout/toolbar/toolbar-separator';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { ColorPickerButton } from '@workspace/ui/components/media/color-picker-button';
import { FontPicker } from '@workspace/ui/components/media/font-picker';
import { AlignCenter, AlignLeft, AlignRight, Baseline, Bold, Highlighter, Italic } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import {
    handleBold,
    handleFont,
    handleHorizontalAlign,
    handleItalic,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
    resolveFontName,
} from '../../state';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { FontSizeStepper } from './font-size-stepper';

// Width seam below which this toolbar hides — MenuBar keys its grid on the same seam.
export const formatToolbarQuery = '(min-width: 1360px)';

// Quick-format controls mirrored from the docs toolbar, driving the exact same
// handlers as the Format menu — an extra surface, not a replacement. The menu bar's
// 1fr·auto·1fr grid centers this on the bar; the min-width gate hides it (with
// read-only) below the width where the side blocks still leave room to sit centered.
export function FormatToolbar() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    const hasSpace = useMediaQuery(formatToolbarQuery);
    // Reflect the anchor cell so the swatches + active alignment track the selection,
    // the way the docs toolbar follows the caret.
    const cell = useAnchorCell();

    if (!hasSpace || !context.allowEdit) return null;

    // `ht` is stored as '1'/'0'/'2' by the align handler but as a number on
    // defaults/imports — coerce before comparing.
    const textColor = cell?.fc ?? '';
    const fillColor = cell?.bg ?? '';
    const align = cell?.ht == null ? undefined : Number(cell.ht); // 0 = center, 1 = left, 2 = right
    const fontName = resolveFontName(cell?.ff);
    const fontSize = Number(cell?.fs) || settings.defaultFontSize;
    const bold = Number(cell?.bl) === 1;
    const italic = Number(cell?.it) === 1;

    return (
        <div className="flex items-center gap-0.5">
            <FontPicker
                value={fontName}
                onChange={(name) => {
                    setContext((ctx) => {
                        handleFont(ctx, refs.cellInput.current!, name);
                    });
                }}
            />

            <ToolbarSeparator />

            <FontSizeStepper
                value={fontSize}
                onChange={(size) => {
                    setContext((ctx) => {
                        handleTextSize(ctx, refs.cellInput.current!, size);
                    });
                }}
            />

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
                popoverClassName="luckysheet-mousedown-cancel"
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
                popoverClassName="luckysheet-mousedown-cancel"
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
