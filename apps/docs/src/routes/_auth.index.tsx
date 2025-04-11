import {createFileRoute} from '@tanstack/react-router'
import {CollaborativeEditor} from '@/components/docs/editor'

export const Route = createFileRoute('/_auth/')({
    component: CollaborativeTextEditor,
})

function CollaborativeTextEditor() {
    return (
        <CollaborativeEditor/>
    )
}
