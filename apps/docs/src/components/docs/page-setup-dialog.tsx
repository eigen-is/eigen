import type { PageMargin, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    cmText,
    MIN_TEXT_MM,
    matchPaperSize,
    PAPER_SIZES,
    pageRecord,
    readCm,
    readPageSetup,
} from '@workspace/lib/docs/eigendoc';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useState } from 'react';

type PageSetupDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    setup: PageSetup;
    canWrite: boolean;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
};

const MARGIN_FIELDS: { side: keyof PageMargin; label: string }[] = [
    { side: 'top', label: 'Top' },
    { side: 'bottom', label: 'Bottom' },
    { side: 'left', label: 'Left' },
    { side: 'right', label: 'Right' },
];

const CUSTOM = 'Custom';

// Margins to 0.01 cm, as Google shows 0.75 in as 1.91 cm.
const marginText = (mm: number) => cmText(mm, 2);
// Portrait first, as Google lists every paper.
const paperLabel = (name: string, width: number, height: number) =>
    `${name} (${(Math.min(width, height) / 10).toFixed(1)} cm × ${(Math.max(width, height) / 10).toFixed(1)} cm)`;

// Google Docs' Pages tab without Apply to, Page colour and Set as default: a doc has one page, and no pageless form.
export function PageSetupDialog({ open, onOpenChange, setup, canWrite, onSetupChange }: PageSetupDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>Page setup</DialogTitle>
                </DialogHeader>
                <PageSetupForm
                    setup={setup}
                    canWrite={canWrite}
                    onSubmit={onSetupChange}
                    onDone={() => onOpenChange(false)}
                />
            </DialogContent>
        </Dialog>
    );
}

type PageSetupFormProps = {
    setup: PageSetup;
    canWrite: boolean;
    onSubmit: (from: PageSetup, to: PageSetup) => void;
    onDone: () => void;
};

// Mounted with the dialog, so each opening starts from the doc's page as it was then.
function PageSetupForm({ setup, canWrite, onSubmit, onDone }: PageSetupFormProps) {
    const [initial] = useState(setup);
    const [paper, setPaper] = useState({ width: initial.width, height: initial.height });
    const [text, setText] = useState({
        top: marginText(initial.margin.top),
        right: marginText(initial.margin.right),
        bottom: marginText(initial.margin.bottom),
        left: marginText(initial.margin.left),
    });

    const landscape = paper.width > paper.height;
    // An untouched field keeps the stored size, not its rounding.
    const margin = (side: keyof PageMargin) =>
        text[side] === marginText(initial.margin[side]) ? initial.margin[side] : readCm(text[side]);
    const candidate: PageSetup = {
        ...initial,
        ...paper,
        margin: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
    };
    // Valid is what the stored page would read back unchanged.
    const read = readPageSetup(pageRecord(candidate));
    const valid = MARGIN_FIELDS.every(({ side }) => read.margin[side] === candidate.margin[side]);

    const turn = (size: { width: number; height: number }, toLandscape: boolean) =>
        setPaper(
            size.width > size.height === toLandscape
                ? { width: size.width, height: size.height }
                : { width: size.height, height: size.width },
        );

    return (
        <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                onSubmit(initial, candidate);
                onDone();
            }}
        >
            <div className="grid gap-6 sm:grid-cols-2">
                <div className="flex flex-col gap-6">
                    <FieldSet>
                        <FieldLegend variant="label">Orientation</FieldLegend>
                        <RadioGroup
                            value={landscape ? 'landscape' : 'portrait'}
                            onValueChange={(value) => turn(paper, value === 'landscape')}
                            disabled={!canWrite}
                        >
                            <div className="flex items-center gap-2">
                                <RadioGroupItem value="portrait" id="page-setup-portrait" />
                                <Label htmlFor="page-setup-portrait">Portrait</Label>
                            </div>
                            <div className="flex items-center gap-2">
                                <RadioGroupItem value="landscape" id="page-setup-landscape" />
                                <Label htmlFor="page-setup-landscape">Landscape</Label>
                            </div>
                        </RadioGroup>
                    </FieldSet>

                    <Field>
                        <FieldLabel htmlFor="page-setup-paper">Paper size</FieldLabel>
                        <Select
                            value={matchPaperSize(paper) ?? CUSTOM}
                            onValueChange={(name) => {
                                const size = PAPER_SIZES.find((p) => p.name === name);
                                if (size) turn(size, landscape);
                            }}
                            disabled={!canWrite}
                        >
                            <SelectTrigger id="page-setup-paper" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {PAPER_SIZES.map(({ name, width, height }) => (
                                    <SelectItem key={name} value={name}>
                                        {paperLabel(name, width, height)}
                                    </SelectItem>
                                ))}
                                {!matchPaperSize(initial) && (
                                    <SelectItem value={CUSTOM} disabled>
                                        {paperLabel(CUSTOM, initial.width, initial.height)}
                                    </SelectItem>
                                )}
                            </SelectContent>
                        </Select>
                    </Field>
                </div>

                <FieldSet className="gap-3">
                    <FieldLegend variant="label">Margins (centimetres)</FieldLegend>
                    {MARGIN_FIELDS.map(({ side, label }) => (
                        <Field key={side} orientation="horizontal">
                            <FieldLabel htmlFor={`page-setup-${side}`}>{label}</FieldLabel>
                            <Input
                                id={`page-setup-${side}`}
                                type="number"
                                step="any"
                                className="w-24"
                                value={text[side]}
                                onChange={(e) => setText({ ...text, [side]: e.target.value })}
                                disabled={!canWrite}
                            />
                        </Field>
                    ))}
                    {!valid && (
                        <FieldError>
                            Margins must be 0 cm or more and leave at least {cmText(MIN_TEXT_MM, 1)} cm for the text.
                        </FieldError>
                    )}
                </FieldSet>
            </div>

            {canWrite ? (
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onDone}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!valid}>
                        OK
                    </Button>
                </DialogFooter>
            ) : (
                <DialogFooter showCloseButton />
            )}
        </form>
    );
}

type HeadersAndFootersDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    setup: PageSetup;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
};

const DISTANCE_FIELDS = [
    { key: 'headerDistance', label: 'Header (centimetres from top)' },
    { key: 'footerDistance', label: 'Footer (centimetres from bottom)' },
] as const;

type DistanceKey = (typeof DISTANCE_FIELDS)[number]['key'];

// Google Docs' Headers and footers, from a band's Options: the bands' distances from the paper's edge and Different
// first page, without odd and even pages, which a doc has no bands for. Only a writer enters a band.
export function HeadersAndFootersDialog({ open, onOpenChange, setup, onSetupChange }: HeadersAndFootersDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="xs" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>Headers and footers</DialogTitle>
                </DialogHeader>
                <HeadersAndFootersForm setup={setup} onSubmit={onSetupChange} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog, as the page setup form is.
function HeadersAndFootersForm({ setup, onSubmit, onDone }: Omit<PageSetupFormProps, 'canWrite'>) {
    const [initial] = useState(setup);
    const [text, setText] = useState({
        headerDistance: marginText(initial.headerDistance),
        footerDistance: marginText(initial.footerDistance),
    });
    const [differentFirstPage, setDifferentFirstPage] = useState(initial.differentFirstPage);

    // An untouched field keeps the stored distance, not its rounding.
    const distance = (key: DistanceKey) => (text[key] === marginText(initial[key]) ? initial[key] : readCm(text[key]));
    const candidate: PageSetup = {
        ...initial,
        headerDistance: distance('headerDistance'),
        footerDistance: distance('footerDistance'),
        differentFirstPage,
    };
    // Valid is what the stored page would read back unchanged: each band between the paper's edge and its margin.
    const read = readPageSetup(pageRecord(candidate));
    const valid = DISTANCE_FIELDS.every(({ key }) => read[key] === candidate[key]);

    return (
        <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                onSubmit(initial, candidate);
                onDone();
            }}
        >
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Margins</FieldLegend>
                {DISTANCE_FIELDS.map(({ key, label }) => (
                    <Field key={key} orientation="horizontal">
                        <FieldLabel htmlFor={`headers-and-footers-${key}`}>{label}</FieldLabel>
                        <Input
                            id={`headers-and-footers-${key}`}
                            type="number"
                            step="any"
                            className="w-24"
                            value={text[key]}
                            onChange={(e) => setText({ ...text, [key]: e.target.value })}
                        />
                    </Field>
                ))}
                {!valid && (
                    <FieldError>
                        The header must be 0 to {marginText(initial.margin.top)} cm from the top and the footer 0 to{' '}
                        {marginText(initial.margin.bottom)} cm from the bottom, within their margins.
                    </FieldError>
                )}
            </FieldSet>

            <FieldSet className="gap-3">
                <FieldLegend variant="label">Layout</FieldLegend>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="headers-and-footers-first-page"
                        checked={differentFirstPage}
                        onCheckedChange={(checked) => setDifferentFirstPage(checked === true)}
                    />
                    <Label htmlFor="headers-and-footers-first-page" className="font-normal">
                        Different first page
                    </Label>
                </div>
            </FieldSet>

            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                    Apply
                </Button>
            </DialogFooter>
        </form>
    );
}
