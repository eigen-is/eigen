// A text field that suggests contacts as you type an address, such as a mail draft's To line or a share
// list's add row. In append mode a pick adds to a comma-separated list; otherwise it replaces the value. Arrow keys,
// Enter and Tab pick from the list, and the caller may own the value or leave it to the field.

import { useContactSuggestions } from '@workspace/lib/contacts';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { Input } from '@workspace/ui/components/input';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import { ContactSuggestList } from './contact-suggest-list';

type ContactAutosuggestProps = {
    initialValue?: string;
    value?: string;
    onChange?: (value: string) => void;
    appendMode?: boolean;
    excludeEmails?: string[];
    inputClassName?: string;
    placeholder?: string;
    disabled?: boolean;
    autoComplete?: string;
    id?: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
    onSubmit?: (value: string) => void;
    // An Enter in the empty field runs the caller's main action, such as moving on to the next step.
    onEmptyEnter?: () => void;
};

export function ContactAutosuggest({
    initialValue = '',
    value: controlledValue,
    onChange,
    appendMode = false,
    excludeEmails,
    inputClassName = '',
    placeholder = '',
    disabled = false,
    autoComplete = 'one-time-code',
    id,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    onSubmit,
    onEmptyEnter,
}: ContactAutosuggestProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const [internalValue, setInternalValue] = useState(initialValue);
    const inputValue = controlledValue ?? internalValue;

    const { suggestions, isLoading } = useContactSuggestions(inputValue, false, excludeEmails);
    const listOpen = isOpen && suggestions.length > 0;

    const handleSelect = useCallback(
        (suggestion: ContactSuggestion) => {
            const formattedContact = `${suggestion.displayName} <${suggestion.email}>`;

            const newValue =
                appendMode && inputValue
                    ? `${[...inputValue.trim().split(',').slice(0, -1), formattedContact].join(', ')}, `
                    : formattedContact;

            setInternalValue(newValue);
            setSelectedIndex(0);
            onChange?.(newValue);

            setIsOpen(appendMode);
            inputRef.current?.focus();
        },
        [inputValue, onChange, appendMode],
    );

    const handleInputChange = useCallback(
        (e: ChangeEvent<HTMLInputElement>) => {
            const newValue = e.target.value;
            setInternalValue(newValue);
            setIsOpen(true);
            onChange?.(newValue);
        },
        [onChange],
    );

    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (!listOpen) return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev));
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
                    break;

                case 'Enter':
                case 'Tab':
                    e.preventDefault();
                    if (suggestions[selectedIndex]) {
                        handleSelect(suggestions[selectedIndex]);
                    }
                    break;

                case 'Escape':
                    e.preventDefault();
                    setIsOpen(false);
                    break;
            }
        },
        [listOpen, suggestions, selectedIndex, handleSelect],
    );

    const handleKeyDownSubmit = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter' || event.defaultPrevented) return;
        if (!inputValue.trim() && onEmptyEnter) {
            event.preventDefault();
            onEmptyEnter();
            return;
        }
        if (onSubmit) {
            event.preventDefault();
            onSubmit(inputValue);
        }
    };

    const handleFocus = useCallback(() => {
        setIsOpen(true);
    }, []);

    const handleBlur = useCallback(() => {
        setTimeout(() => {
            if (inputRef.current !== document.activeElement) {
                setIsOpen(false);
            }
        }, 300);
    }, []);

    return (
        <div className="relative">
            <Input
                id={id}
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={(e) => {
                    handleKeyDown(e);
                    handleKeyDownSubmit(e);
                }}
                role="combobox"
                aria-expanded={listOpen}
                className={inputClassName}
                placeholder={placeholder}
                disabled={disabled}
                autoComplete={autoComplete}
                aria-invalid={ariaInvalid}
                aria-describedby={ariaDescribedBy}
            />

            {isOpen && (
                <ContactSuggestList
                    items={suggestions}
                    selectedIndex={selectedIndex}
                    onSelect={handleSelect}
                    className="w-full mt-1"
                />
            )}

            {isOpen && isLoading && (
                <div className="absolute z-10 w-full bg-background mt-1 border rounded-md shadow-lg p-3 text-center">
                    Loading...
                </div>
            )}
        </div>
    );
}
