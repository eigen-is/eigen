import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { is_date } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import { DATE_FORMAT_PRESETS, en, handleNumberFormat } from '../../state';
import {
    DATE_TOKENS,
    DATETIME_SAMPLE_SERIAL,
    type FormatSegment,
    getDateToken,
    previewPattern,
    serializeSegments,
    tokenizePattern,
} from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

const TOKEN_GROUPS: { label: string; group: 'date' | 'time' | 'duration' }[] = [
    { label: 'Date', group: 'date' },
    { label: 'Time', group: 'time' },
    { label: 'Duration', group: 'duration' },
];

function TokenChip({
    segment,
    onVariantChange,
    onDelete,
}: {
    segment: Extract<FormatSegment, { kind: 'token' }>;
    onVariantChange: (pattern: string) => void;
    onDelete: () => void;
}) {
    const token = getDateToken(segment.token);
    const variant = token.variants.find((v) => v.pattern === segment.pattern);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground whitespace-nowrap"
                >
                    {token.label}
                    {variant?.example ? ` (${variant.example})` : ''}
                    <ChevronDown className="size-3 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="sheet-mousedown-cancel">
                {token.variants.map((v) => (
                    <DropdownMenuItem key={v.pattern} onClick={() => onVariantChange(v.pattern)}>
                        <span className="flex w-4 shrink-0 items-center justify-center">
                            {v.pattern === segment.pattern && <Check className="size-4" />}
                        </span>
                        <span>
                            {v.label} ({v.example})
                        </span>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete}>
                    <span className="w-4 shrink-0" />
                    <span>Delete</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function CustomDateTimeFormats() {
    const { setContext, refs } = useContext(WorkbookContext);
    const { button, format } = en;
    const { hideDialog } = useDialog();

    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const [segments, setSegments] = useState<FormatSegment[]>(() =>
        tokenizePattern(anchorFa && is_date(anchorFa) ? anchorFa : 'dd/MM/yyyy'),
    );

    const pattern = serializeSegments(segments);
    const preview = pattern ? previewPattern(pattern, DATETIME_SAMPLE_SERIAL) : { ok: true as const, text: '' };

    const replaceSegment = (index: number, segment: FormatSegment) => {
        setSegments((prev) => prev.map((s, i) => (i === index ? segment : s)));
    };

    const apply = () => {
        setContext((ctx) => {
            handleNumberFormat(ctx, refs.cellInput.current!, pattern);
        });
        hideDialog();
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>{format.titleDateTime}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 shrink-0">
                <div className="flex flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1.5 min-h-9">
                    {segments.map((segment, index) =>
                        segment.kind === 'token' ? (
                            <TokenChip
                                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no identity
                                key={`token-${index}`}
                                segment={segment}
                                onVariantChange={(p) => replaceSegment(index, { ...segment, pattern: p })}
                                onDelete={() => setSegments((prev) => prev.filter((_, i) => i !== index))}
                            />
                        ) : (
                            <input
                                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no identity
                                key={`literal-${index}`}
                                className="h-5 bg-transparent text-sm outline-none"
                                style={{ width: `${Math.max(segment.text.length, 1)}ch` }}
                                value={segment.text}
                                onChange={(e) => replaceSegment(index, { kind: 'literal', text: e.target.value })}
                            />
                        ),
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Insert token"
                                className="ml-auto inline-flex items-center rounded-md px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            >
                                <ChevronDown className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="sheet-mousedown-cancel" align="end">
                            {TOKEN_GROUPS.map(({ label, group }) => (
                                <div key={group}>
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                                        {label}
                                    </DropdownMenuLabel>
                                    {DATE_TOKENS.filter((t) => t.group === group).map((token) => (
                                        <DropdownMenuItem
                                            key={token.id}
                                            onClick={() =>
                                                setSegments((prev) => [
                                                    ...prev,
                                                    { kind: 'token', token: token.id, pattern: token.insertPattern },
                                                ])
                                            }
                                        >
                                            {token.label}
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={() => setSegments((prev) => [...prev, { kind: 'literal', text: '' }])}
                            >
                                Separator text
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                {preview.ok ? (
                    <div className="text-sm text-muted-foreground">
                        {format.preview}: <span className="text-foreground">{preview.text}</span>
                    </div>
                ) : (
                    <div className="text-sm text-destructive">{preview.error}</div>
                )}
            </div>
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {DATE_FORMAT_PRESETS.map(({ name, value }) => (
                    <div
                        className={cn(
                            'flex items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item',
                            value === pattern && 'eigen-list-item-active',
                        )}
                        key={value}
                        onClick={() => setSegments(tokenizePattern(value))}
                        tabIndex={0}
                    >
                        <span>{name}</span>
                        <span className="text-muted-foreground font-mono">{value}</span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
                <Button size="sm" disabled={!pattern || !preview.ok} onClick={apply}>
                    {button.apply}
                </Button>
            </DialogFooter>
        </div>
    );
}
