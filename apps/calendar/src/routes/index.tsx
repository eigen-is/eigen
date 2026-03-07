import {createFileRoute} from '@tanstack/react-router'
import {Calendar} from 'lucide-react'
import {Column, ColumnLayout} from "@workspace/ui/components/layout";
import {Toolbar} from "@workspace/ui/components/layout/toolbar";

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    return (
        <ColumnLayout>
            <Column id={"1"} width={"flex"} toolbar={
                <Toolbar><></>
                </Toolbar>}>
                <div className="flex-1 flex items-center justify-center h-full bg-muted">
                    <div className="text-center space-y-4">
                        <Calendar className="h-16 w-16 text-muted-foreground mx-auto"/>
                        <h2 className="text-2xl font-semibold text-muted-foreground">Calendar</h2>
                        <p className="text-muted-foreground">Under construction</p>
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
