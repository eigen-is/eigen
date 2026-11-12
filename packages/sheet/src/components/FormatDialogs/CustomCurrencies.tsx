// The Custom currencies dialog: a currency symbol and a layout, such as symbol first with two decimals, built
// into a number format with buildCurrencyPattern and applied to the selection.

import { numberDisplay } from '@workspace/formula/format';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useState } from 'react';
import { CURRENCIES, MENU_CURRENCY } from '../../state';
import { FormatDialog, PresetList, PresetRow } from './format-dialog';
import type { CurrencyVariantId } from './format-pattern';
import { buildCurrencyPattern, CURRENCY_VARIANT_IDS } from './format-pattern';

type Currency = (typeof CURRENCIES)[number];

// The euro first, then the rest by name, each with 1000.12 in its own layout.
const LISTED_CURRENCIES = [...CURRENCIES]
    .sort((a, b) => {
        if (a.name === 'EUR') return -1;
        if (b.name === 'EUR') return 1;
        return a.name.localeCompare(b.name);
    })
    .map((currency) => ({
        ...currency,
        example: numberDisplay(
            1000.12,
            buildCurrencyPattern(currency.value, currency.pos === 'after' ? 'symbolLast' : 'symbolFirst'),
        ),
    }));

export function CustomCurrencies() {
    const [symbol, setSymbol] = useState<string>(MENU_CURRENCY);
    const [variantId, setVariantId] = useState<CurrencyVariantId>('symbolFirst');
    const [selectedName, setSelectedName] = useState<string | null>(
        () => CURRENCIES.find((c) => c.value === MENU_CURRENCY)?.name ?? null,
    );
    // The field holds the active symbol, and only text the user typed filters the list. A prefilled or picked symbol
    // keeps the whole list in view.
    const [query, setQuery] = useState('');

    const needle = query.trim().toLowerCase();
    const currencies = needle
        ? LISTED_CURRENCIES.filter((c) => c.name.toLowerCase().includes(needle))
        : LISTED_CURRENCIES;

    // A picked currency takes its own side of the number and keeps the rounding chosen.
    const selectCurrency = (currency: Currency) => {
        const rounded = variantId === 'symbolFirstRounded' || variantId === 'symbolLastRounded';
        const after = currency.pos === 'after';
        setSymbol(currency.value);
        setQuery('');
        setSelectedName(currency.name);
        setVariantId(
            rounded ? (after ? 'symbolLastRounded' : 'symbolFirstRounded') : after ? 'symbolLast' : 'symbolFirst',
        );
    };

    return (
        <FormatDialog title="Custom currencies" pattern={buildCurrencyPattern(symbol, variantId)} canSubmit={!!symbol}>
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
                <Select
                    value={variantId}
                    onValueChange={(value) => {
                        const id = CURRENCY_VARIANT_IDS.find((variant) => variant === value);
                        if (id) setVariantId(id);
                    }}
                >
                    <SelectTrigger className="w-40">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {CURRENCY_VARIANT_IDS.map((id) => (
                            <SelectItem value={id} key={id}>
                                {symbol ? numberDisplay(1000, buildCurrencyPattern(symbol, id)) : ''}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <PresetList>
                {currencies.map((currency) => (
                    <PresetRow
                        key={currency.name}
                        active={currency.name === selectedName}
                        onPick={() => selectCurrency(currency)}
                    >
                        <span>{currency.name}</span>
                        <span className="text-muted-foreground">{currency.example}</span>
                    </PresetRow>
                ))}
            </PresetList>
        </FormatDialog>
    );
}
