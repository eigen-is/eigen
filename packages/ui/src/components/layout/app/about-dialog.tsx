import { getChangelogUrl, getLicensesUrl } from '@workspace/lib/api';
import { formatInputDate } from '@workspace/lib/date';
import { usePublicConfig } from '@workspace/lib/public';
import { Github, Scale, ScrollText } from 'lucide-react';
import { Button } from '../../button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../dialog';

type AboutDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
    const { data: config } = usePublicConfig();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader className="items-center">
                    <DialogTitle className="sr-only">About Eigen</DialogTitle>
                    <div className="text-3xl font-medium select-none" style={{ color: 'var(--app-space-color)' }}>
                        eigen
                    </div>
                    <p className="text-sm text-muted-foreground text-center">
                        Your personal workspace in the cloud.
                        <br />
                        Simple and secure. You control your own data.
                    </p>
                </DialogHeader>

                <div className="space-y-4 text-sm">
                    <div className="text-center text-xs text-muted-foreground">
                        <a href={getChangelogUrl()} target="_blank" rel="noreferrer" className="hover:text-foreground">
                            Version {config?.version ?? '—'}
                            {config?.commit && (
                                <>
                                    {' · '}
                                    {config.commit}
                                    {config.builtAt && ` · ${formatInputDate(config.builtAt)}`}
                                </>
                            )}
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href="https://github.com/eigen-is/eigen"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <Github className="size-3.5" />
                            github.com/eigen-is/eigen
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href={getLicensesUrl()}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <Scale className="size-3.5" />
                            Open-source licenses
                        </a>
                    </div>

                    <div className="flex justify-center text-xs text-muted-foreground">
                        <a
                            href={getChangelogUrl()}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                            <ScrollText className="size-3.5" />
                            Changelog
                        </a>
                    </div>
                </div>

                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>OK</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
