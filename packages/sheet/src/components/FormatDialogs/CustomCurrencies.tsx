// The Custom currencies dialog: a currency symbol and a layout, such as symbol first with two decimals, built
// into a number format with buildCurrencyPattern and applied to the selection.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialogProps } from '../../hooks/useDialog';
import { CURRENCIES, handleNumberFormat } from '../../state';
import type { CurrencyVariantId } from './format-pattern';
import { buildCurrencyPattern, CURRENCY_VARIANTS } from './format-pattern';

export function CustomCurrencies() {
    const { setContext, refs, settings } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();

    const [symbol, setSymbol] = useState(settings.currency);
    const [variantId, setVariantId] = useState<CurrencyVariantId>('symbolFirst');
    const [selectedName, setSelectedName] = useState<string | null>(
        () => CURRENCIES.find((c) => c.value === settings.currency)?.name ?? null,
    );
    // The field holds the active symbol, and only text the user typed filters the list. A prefilled or picked symbol
    // keeps the whole list in view.
    const [query, setQuery] = useState('');

    const allCurrencies = useMemo(
        () =>
            [...CURRENCIES]
                .sort((a, b) => {
                    if (a.name === 'EUR') return -1;
                    if (b.name === 'EUR') return 1;
                    return a.name.localeCompare(b.name);
                })
                .map((c) => ({
                    ...c,
                    example: update(
                        buildCurrencyPattern(c.value, c.pos === 'after' ? 'symbolLast' : 'symbolFirst'),
                        1000.12,
                    ),
                })),
        [],
    );

    const needle = query.trim().toLowerCase();
    const currencies = needle ? allCurrencies.filter((c) => c.name.toLowerCase().includes(needle)) : allCurrencies;

    const selectCurrency = (currency: { name: string; pos?: string; value: string }) => {
        const rounded = variantId === 'symbolFirstRounded' || variantId === 'symbolLastRounded';
        setSymbol(currency.value);
        setQuery('');
        setSelectedName(currency.name);
        setVariantId(
            currency.pos === 'after'
                ? rounded
                    ? 'symbolLastRounded'
                    : 'symbolLast'
                : rounded
                  ? 'symbolFirstRounded'
                  : 'symbolFirst',
        );
    };

    return (
        <FormDialog {...dialogProps} title="Custom currencies" size="md">
            <FormDialogForm
                submitLabel="Apply"
                canSubmit={!!symbol}
                onSubmit={() =>
                    setContext((ctx) => {
                        const cellInput = refs.cellInput.current;
                        if (!cellInput) return;
                        handleNumberFormat(ctx, cellInput, buildCurrencyPattern(symbol, variantId));
                    })
                }
            >
                <div className="flex items-center gap-2">
                    <Input
                        className="flex-1"
                        aria-label="Currency symbol"
                        value={symbol}
                        onChange={(e) => {
                            setSymbol(e.target.value);
                            setQuery(e.target.value);
                            setSelectedName(null);
                        }}
                    />
                    <Select value={variantId} onValueChange={(v) => setVariantId(v as CurrencyVariantId)}>
                        <SelectTrigger className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CURRENCY_VARIANTS.map(({ id }) => (
                                <SelectItem value={id} key={id}>
                                    {symbol ? update(buildCurrencyPattern(symbol, id), 1000) : ''}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="max-h-[40vh] border border-border rounded-md overflow-y-auto">
                    {currencies.map((currency) => (
                        <button
                            type="button"
                            className={cn(
                                'flex w-full items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item',
                                currency.name === selectedName && 'eigen-list-item-active',
                            )}
                            key={currency.name}
                            onClick={() => selectCurrency(currency)}
                        >
                            <span>{currency.name}</span>
                            <span className="text-muted-foreground">{currency.example}</span>
                        </button>
                    ))}
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}
