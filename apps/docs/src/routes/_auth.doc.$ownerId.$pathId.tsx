import {createFileRoute} from '@tanstack/react-router'
import {CollaborativeEditor} from '@/components/docs/editor'

export const Route = createFileRoute('/_auth/doc/$ownerId/$pathId')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    const {ownerId, pathId} = Route.useParams();
    
    return (
        <div className="bg-muted flex-1 overflow-hidden">
            <CollaborativeEditor ownerId={ownerId} pathId={pathId}/>
        </div>
    )
}
