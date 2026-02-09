import {cn} from "@workspace/ui/lib/utils";
import {type MediaStyleOptions} from "./media.types";

type MediaStylePickerProps = {
    value: MediaStyleOptions;
    onChange: (options: MediaStyleOptions) => void;
};

const radiusOptions: MediaStyleOptions['borderRadius'][] = ['none', 'sm', 'md', 'lg', 'xl', 'full'];
const shadowOptions: MediaStyleOptions['shadow'][] = ['none', 'sm', 'md', 'lg', 'xl'];

const radiusClasses: Record<MediaStyleOptions['borderRadius'], string> = {
    none: 'rounded-none',
    sm: 'rounded-sm',
    md: 'rounded',
    lg: 'rounded-lg',
    xl: 'rounded-xl',
    full: 'rounded-full',
};

const shadowClasses: Record<MediaStyleOptions['shadow'], string> = {
    none: '',
    sm: 'shadow-sm',
    md: 'shadow',
    lg: 'shadow-lg',
    xl: 'shadow-xl',
};

export function MediaStylePicker({value, onChange}: MediaStylePickerProps) {
    const update = (partial: Partial<MediaStyleOptions>) => {
        onChange({...value, ...partial});
    };

    return (
        <div className="flex flex-col gap-4 p-2 min-w-48">
            <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Corners</div>
                <div className="flex gap-1">
                    {radiusOptions.map((radius) => (
                        <button
                            key={radius}
                            onClick={() => update({borderRadius: radius})}
                            className={cn(
                                "size-7 bg-muted border-2 transition-colors",
                                radiusClasses[radius],
                                value.borderRadius === radius
                                    ? "border-primary"
                                    : "border-transparent hover:border-muted-foreground/30"
                            )}
                            title={radius}
                        />
                    ))}
                </div>
            </div>

            <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Shadow</div>
                <div className="flex gap-1">
                    {shadowOptions.map((shadow) => (
                        <button
                            key={shadow}
                            onClick={() => update({shadow})}
                            className={cn(
                                "size-7 bg-background rounded border-2 transition-colors",
                                shadowClasses[shadow],
                                value.shadow === shadow
                                    ? "border-primary"
                                    : "border-transparent hover:border-muted-foreground/30"
                            )}
                            title={shadow}
                        />
                    ))}
                </div>
            </div>

            <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Border</div>
                <div className="flex gap-1">
                    <button
                        onClick={() => update({border: false})}
                        className={cn(
                            "size-7 bg-muted rounded border-2 transition-colors",
                            !value.border
                                ? "border-primary"
                                : "border-transparent hover:border-muted-foreground/30"
                        )}
                        title="No border"
                    />
                    <button
                        onClick={() => update({border: true})}
                        className={cn(
                            "size-7 bg-muted rounded transition-colors",
                            "ring-2 ring-inset ring-muted-foreground/50",
                            value.border
                                ? "border-2 border-primary"
                                : "border-2 border-transparent hover:border-muted-foreground/30"
                        )}
                        title="With border"
                    />
                </div>
            </div>
        </div>
    );
}
