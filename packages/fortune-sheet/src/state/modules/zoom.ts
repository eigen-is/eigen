// Zoom step
// const ZOOM_WHEEL_STEP = 0.02; // ctrl + mouse wheel
const ZOOM_STEP = 0.1; // click and Ctrl + +-

// Zoom max/min ratios
export const MAX_ZOOM_RATIO = 4;
export const MIN_ZOOM_RATIO = 0.1;

export function handleKeydownForZoom(ev: KeyboardEvent, currentZoom: number) {
    if (!ev.ctrlKey) {
        return currentZoom;
    }
    let handled = false;
    let zoom = currentZoom || 1;
    if (ev.key === "-" || ev.which === 189) {
        zoom -= ZOOM_STEP;
        handled = true;
    } else if (ev.key === "+" || ev.which === 187) {
        zoom += ZOOM_STEP;
        handled = true;
    } else if (ev.key === "0" || ev.which === 48) {
        zoom = 1;
        handled = true;
    }

    if (handled) {
        ev.preventDefault();
        if (zoom >= MAX_ZOOM_RATIO) {
            zoom = MAX_ZOOM_RATIO;
        } else if (zoom < MIN_ZOOM_RATIO) {
            zoom = MIN_ZOOM_RATIO;
        }
    }
    return parseFloat(zoom.toFixed(1));
}
