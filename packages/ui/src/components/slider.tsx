import { cn } from '@workspace/ui/lib/utils';
import { Slider as SliderPrimitive } from 'radix-ui';
import type * as React from 'react';

function Slider({
    className,
    defaultValue,
    value,
    min = 0,
    max = 100,
    'aria-label': ariaLabel,
    ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
    // One thumb per value; an uncontrolled slider with neither prop is the single-thumb case.
    const values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min];

    return (
        <SliderPrimitive.Root
            data-slot="slider"
            defaultValue={defaultValue}
            value={value}
            min={min}
            max={max}
            className={cn(
                'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
                className,
            )}
            {...props}
        >
            <SliderPrimitive.Track
                data-slot="slider-track"
                className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
            >
                <SliderPrimitive.Range
                    data-slot="slider-range"
                    className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
                />
            </SliderPrimitive.Track>
            {values.map((_, index) => (
                <SliderPrimitive.Thumb
                    // The thumb, not the root, is the role="slider" element — the name belongs here.
                    aria-label={ariaLabel}
                    data-slot="slider-thumb"
                    key={index}
                    className="block size-3.5 shrink-0 rounded-full border border-primary bg-background shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
                />
            ))}
        </SliderPrimitive.Root>
    );
}

export { Slider };
