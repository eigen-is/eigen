// Every insert path goes through here, so no callsite can forget the home frame. In frame mode the
// viewport's scene space IS the frame's space, so an insert needs no coordinate translation — the
// stamp is the whole of it. `frameId` sits AFTER the spread on purpose: a pasted element carries the
// source frame's id and must land in the frame being pasted into.
export function homeToFrame<T extends { frameId?: string }>(partial: T, frameId: string): T & { frameId: string } {
    return { ...partial, frameId };
}
