import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import { getFlowdata, locale, updateFormat } from '../../state';
import { buildCurrencyPattern, CURRENCY_VARIANTS, type CurrencyVariantId } from './format-pattern';

export function CustomCurrencies() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    const { button, format, currencyDetail } = locale(context);
    const { hideDialog } = useDialog();

    const [symbol, setSymbol] = useState(settings.currency);
    const [variantId, setVariantId] = useState<CurrencyVariantId>('symbolFirst');
    const [selectedName, setSelectedName] = useState<string | null>(
        () => currencyDetail.find((c) => c.value === settings.currency)?.name ?? null,
    );

    const currencies = useMemo(() => {
        const sorted = [...currencyDetail].sort((a, b) => {
            if (a.name === 'EUR') return -1;
            if (b.name === 'EUR') return 1;
            return a.name.localeCompare(b.name);
        });
        const query = symbol.trim().toLowerCase();
        if (!query) return sorted;
        const matches = sorted.filter(
            (c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query),
        );
        // The field holds the active symbol after a row click — never blank the list.
        return matches.length > 0 ? matches : sorted;
    }, [currencyDetail, symbol]);

    const selectCurrency = (currency: { name: string; pos?: string; value: string }) => {
        const rounded = variantId === 'symbolFirstRounded' || variantId === 'symbolLastRounded';
        setSymbol(currency.value);
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
            const d = getFlowdata(ctx);
            if (d == null) return;
            updateFormat(ctx, refs.cellInput.current!, d, 'ct', fa);
        });
        hideDialog();
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>{format.titleCurrency}</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2 shrink-0">
                <Input
                    className="flex-1"
                    value={symbol}
                    onChange={(e) => {
                        setSymbol(e.target.value);
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
                        <span className="text-muted-foreground">
                            {update(
                                buildCurrencyPattern(
                                    currency.value,
                                    currency.pos === 'after' ? 'symbolLast' : 'symbolFirst',
                                ),
                                1000.12,
                            )}
                        </span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
                <Button size="sm" disabled={!symbol} onClick={apply}>
                    {button.apply}
                </Button>
            </DialogFooter>
        </div>
    );
}
