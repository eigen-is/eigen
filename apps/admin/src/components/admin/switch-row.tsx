import { Switch } from '@workspace/ui/components/switch';

export function SwitchRow({
    label,
    description,
    checked,
    onChange,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <Switch checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
