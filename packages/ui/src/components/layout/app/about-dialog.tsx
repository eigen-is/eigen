import { formatInputDate } from '@workspace/lib/date';
import { usePublicConfig } from '@workspace/lib/public';
import { Github } from 'lucide-react';
import { Button } from '../../button.tsx';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../dialog.tsx';

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
                    <div className="text-3xl font-bold select-none" style={{ color: 'var(--app-space-color)' }}>
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
                        Version {config?.version ?? '—'}
                        {config?.commit && (
                            <>
                                {' · '}
                                {config.commit}
                                {config.builtAt && ` · ${formatInputDate(config.builtAt)}`}
                            </>
                        )}
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
                </div>

                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>OK</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
