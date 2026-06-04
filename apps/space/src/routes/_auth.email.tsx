import { createFileRoute } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" toolbar={<ToolbarTitle>Mail</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <SignatureSection />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
