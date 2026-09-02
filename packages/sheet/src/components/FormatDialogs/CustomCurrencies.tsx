import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import { CURRENCIES, handleNumberFormat } from '../../state';
import { buildCurrencyPattern, CURRENCY_VARIANTS, type CurrencyVariantId } from './format-pattern';

export function CustomCurrencies() {
    const { setContext, refs, settings } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();

    const [symbol, setSymbol] = useState(settings.currency);
    const [variantId, setVariantId] = useState<CurrencyVariantId>('symbolFirst');
    const [selectedName, setSelectedName] = useState<string | null>(
        () => CURRENCIES.find((c) => c.value === settings.currency)?.name ?? null,
    );
    // The field holds the active symbol, but only user-typed text filters the
    // list — a prefilled or clicked symbol keeps the full list visible.
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

    const apply = () => {
        const fa = buildCurrencyPattern(symbol, variantId);
        setContext((ctx) => {
            handleNumberFormat(ctx, refs.cellInput.current!, fa);
        });
        hideDialog();
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>Custom currencies</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2 shrink-0">
                <Input
                    className="flex-1"
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
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {currencies.map((currency) => (
                    <div
                        className={cn(
                            'flex items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item',
                            currency.name === selectedName && 'eigen-list-item-active',
                        )}
                        key={currency.name}
                        onClick={() => selectCurrency(currency)}
                        tabIndex={0}
                    >
                        <span>{currency.name}</span>
                        <span className="text-muted-foreground">{currency.example}</span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    Cancel
                </Button>
                <Button size="sm" disabled={!symbol} onClick={apply}>
                    Apply
                </Button>
            </DialogFooter>
        </div>
    );
}
