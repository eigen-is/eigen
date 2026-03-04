import {Search} from 'lucide-react';
import {cn} from "@workspace/ui/lib/utils";
import {InputGroup, InputGroupAddon, InputGroupInput, InputGroupText} from "@workspace/ui/components/input-group";
import {ChangeEvent} from 'react';

export type SearchBarProps = {
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    className?: string;
    inputClassName?: string;
    maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
}

export function SearchBar({
                              placeholder = "Search...",
                              value,
                              onChange,
                              className,
                              inputClassName,
                              maxWidth = "sm"
                          }: SearchBarProps) {
    // Mapping for max-width classes
    const maxWidthClasses = {
        xs: 'max-w-xs',
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl',
        full: 'max-w-full'
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        onChange(e.target.value);
    };

    return (
        <div className={cn("w-full", maxWidthClasses[maxWidth], className)}>
            <InputGroup>
                <InputGroupAddon align="inline-start">
                    <InputGroupText><Search className="h-4 w-4"/></InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                    type="text"
                    placeholder={placeholder}
                    className={cn("w-full", inputClassName)}
                    value={value}
                    onChange={handleChange}
                />
            </InputGroup>
        </div>
    );
}
