// A short burst of confetti that sprays up from a point on the screen and falls under gravity, for
// useCelebrate. It draws on one full-viewport canvas that clicks pass through, and the canvas removes
// itself after about a second and a half. The pieces take the theme's chart colors, so they follow
// light and dark mode. A burst asked for while one is still running is dropped.

const PIECES = 80;
const DURATION_MS = 1500;
const FADE_MS = 400;
const GRAVITY = 1400;
const COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

type Piece = { x: number; y: number; vx: number; vy: number; angle: number; spin: number; color: string };

let running = false;

export function burstConfetti(origin: DOMRect): void {
    if (running) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    running = true;

    const ratio = window.devicePixelRatio;
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    // z-index 50 like a dialog: appended last, the canvas lands above the dialog the click came from.
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:50';
    document.body.append(canvas);

    const style = getComputedStyle(document.documentElement);
    const colors = COLORS.map((name) => style.getPropertyValue(name));
    const pieces: Piece[] = Array.from({ length: PIECES }, (_, i) => {
        // Up, spread over 120 degrees.
        const direction = -Math.PI / 2 + ((Math.random() - 0.5) * (Math.PI * 2)) / 3;
        const speed = 450 + Math.random() * 550;
        return {
            x: origin.left + origin.width / 2,
            y: origin.top,
            vx: Math.cos(direction) * speed,
            vy: Math.sin(direction) * speed,
            angle: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 20,
            color: colors[i % colors.length],
        };
    });

    let start: number | undefined;
    let last = 0;
    const frame = (now: number) => {
        start ??= now;
        const elapsed = now - start;
        if (elapsed >= DURATION_MS) {
            canvas.remove();
            running = false;
            return;
        }
        // Capped, so a tab that comes back from the background doesn't fling every piece off the screen.
        const dt = Math.min((now - (last || now)) / 1000, 0.05);
        last = now;
        const drag = Math.exp(-1.5 * dt);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, window.innerWidth, window.innerHeight);
        context.globalAlpha = Math.min(1, (DURATION_MS - elapsed) / FADE_MS);
        for (const piece of pieces) {
            piece.vx *= drag;
            piece.vy = piece.vy * drag + GRAVITY * dt;
            piece.x += piece.vx * dt;
            piece.y += piece.vy * dt;
            piece.angle += piece.spin * dt;
            context.save();
            context.translate(piece.x, piece.y);
            context.rotate(piece.angle);
            // Squashing the height with the spin makes a piece of paper seem to tumble.
            context.scale(1, Math.cos(piece.angle * 2));
            context.fillStyle = piece.color;
            context.fillRect(-4, -2.5, 8, 5);
            context.restore();
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}
