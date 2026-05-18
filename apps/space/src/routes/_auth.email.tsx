import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <ColumnLayout>
            <Column
                id="detail"
                width="flex"
                toolbar={<span className="text-sm text-foreground font-normal">Mail</span>}
            >
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <SignatureSection />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
