import {createFileRoute} from '@tanstack/react-router'
import {CollaborativeEditor} from '@/components/docs/editor'

export const Route = createFileRoute('/_auth/doc/$ownerId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    return (
        <div className="bg-muted flex-1 overflow-hidden">
            <CollaborativeEditor/>
        </div>
    )
}
