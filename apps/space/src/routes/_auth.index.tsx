import {createFileRoute} from '@tanstack/react-router'
import {Shovel} from 'lucide-react'

export const Route = createFileRoute('/_auth/')({
    component: HomeComponent,
})

function HomeComponent() {
    return (
        <div className="flex flex-col items-center justify-center h-screen">
            <Shovel className="w-24 h-24 text-app mb-4" />
            <h1 className="text-3xl text-gray-800 select-none">under construction</h1>
        </div>
    );
}
