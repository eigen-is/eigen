import type { PageMargin } from '@workspace/lib/docs/eigendoc';
import { DEFAULT_PAGE_SETUP, PAPER_SIZES } from '@workspace/lib/docs/eigendoc';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';

type PageSetupDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const MARGIN_FIELDS: { side: keyof PageMargin; label: string }[] = [
    { side: 'top', label: 'Top' },
    { side: 'bottom', label: 'Bottom' },
    { side: 'left', label: 'Left' },
    { side: 'right', label: 'Right' },
];

const cm = (mm: number) => mm / 10;

const paper = PAPER_SIZES.find(
    (size) => size.width === DEFAULT_PAGE_SETUP.width && size.height === DEFAULT_PAGE_SETUP.height,
);

// Read-only until a document carries its own page: every control is disabled, not absent.
export function PageSetupDialog({ open, onOpenChange }: PageSetupDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>Page setup</DialogTitle>
                    <DialogDescription>Every document uses this page for now.</DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 sm:grid-cols-2">
                    <div className="flex flex-col gap-6">
                        <FieldSet>
                            <FieldLegend variant="label">Orientation</FieldLegend>
                            <RadioGroup
                                value={DEFAULT_PAGE_SETUP.width > DEFAULT_PAGE_SETUP.height ? 'landscape' : 'portrait'}
                                disabled
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
                            <Select value={paper?.name} disabled>
                                <SelectTrigger id="page-setup-paper" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PAPER_SIZES.map(({ name, width, height }) => (
                                        <SelectItem key={name} value={name}>
                                            {name} ({cm(width).toFixed(1)} cm × {cm(height).toFixed(1)} cm)
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>

                    <FieldSet className="gap-3">
                        <FieldLegend variant="label">Margins (cm)</FieldLegend>
                        {MARGIN_FIELDS.map(({ side, label }) => (
                            <Field key={side} orientation="horizontal">
                                <FieldLabel htmlFor={`page-setup-${side}`}>{label}</FieldLabel>
                                <Input
                                    id={`page-setup-${side}`}
                                    type="number"
                                    className="w-24"
                                    value={cm(DEFAULT_PAGE_SETUP.margin[side])}
                                    disabled
                                />
                            </Field>
                        ))}
                    </FieldSet>
                </div>

                <DialogFooter showCloseButton />
            </DialogContent>
        </Dialog>
    );
}
