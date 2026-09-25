import type { ReactNode } from 'react';

type SettingsSectionProps = {
    title: string;
    description?: ReactNode;
    children: ReactNode;
};

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
    return (
        <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{title}</h3>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
            {children}
        </div>
    );
}
