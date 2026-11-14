// Picks the capture scenes a command line names: none named picks every scene, an unknown name throws with the list.
// It knows a scene only by its name, so its tests run without the capture tool's own install.

export function pickScenes<T extends { name: string }>(names: readonly string[], scenes: readonly T[]): T[] {
    if (names.length === 0) return [...scenes];
    return names.map((name) => {
        const scene = scenes.find((s) => s.name === name);
        if (!scene)
            throw new Error(`Unknown scene ${name}. Scenes: ${scenes.map((s) => s.name).join(', ') || 'none yet'}`);
        return scene;
    });
}
