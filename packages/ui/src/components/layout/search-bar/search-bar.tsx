import {Search} from 'lucide-react';
import {Input} from "@workspace/ui/components/input";
import {cn} from "@workspace/ui/lib/utils";
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
        <div className={cn("relative w-full", maxWidthClasses[maxWidth], className)}>
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"/>
            <Input
                type="text"
                placeholder={placeholder}
                className={cn("pl-8 w-full", inputClassName)}
                value={value}
                onChange={handleChange}
            />
        </div>
    );
}
