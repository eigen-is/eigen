import {Download} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';

export function DownloadHome() {
    return (
        <div>
            <div className="space-y-4">
                <p>Download a complete archive of all your data stored in eigen.</p>
                <p className="text-sm text-muted-foreground">
                    This feature is not yet available. Data export will be added in a future release.
                </p>

                <div className="flex justify-end">
                    <Button disabled className="w-full sm:w-auto">
                        <Download className="mr-2 h-4 w-4"/>
                        Download your data
                    </Button>
                </div>
            </div>
        </div>
    );
}
