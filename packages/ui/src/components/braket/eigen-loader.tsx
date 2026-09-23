import { cn } from '../../lib/utils';

type EigenLoaderProps = {
    className?: string;
};

/*
 * How it's built:
 * - Each chevron has two nested <g> layers: the outer one moves it (slide, hop,
 *   clap, step), the inner one rotates/scales it (spin, flip, stairs).
 * - Three dots sit between the chevrons, invisible except during the dots section.
 * - Every animation runs on the same 34s cycle, so the keyframe percentages
 *   line up across all parts and the loop restarts seamlessly.
 *
 * Timeline:
 *   0–4.5s      breathe (original motion) x3
 *   4.5–7.5s    chevrons take turns hopping
 *   7.5–10.8s   three dots pop in, wave, pop out
 *   10.8–13.2s  chevrons spin, then clap twice
 *   13.2–14.2s  rest
 *   14.2–17.2s  breathe x2
 *   17.2–18s    chevrons flip to point at each other
 *   18–21s      breathe x2, pointing inward
 *   21–23.6s    spin back to normal, then clap twice
 *   24.2–25s    turn 90° into a ^^ zigzag
 *   25.4–28.2s  step: stair down, stair up, stair down, level
 *   28.4–29.2s  flip upside down (vv)
 *   29.4–31.4s  inverted stairs: down, up, level
 *   31.6–32.4s  turn back to < >
 *   32.4–34s    rest
 *
 * The CSS is a template string so JSX doesn't treat its braces as code.
 * Class and keyframe names are prefixed with "el-" because <style> is global.
 */
const css = `
.el-anim { animation-duration: 34s; animation-iteration-count: infinite; animation-timing-function: ease-in-out; }
.el-spin, .el-dot { transform-box: fill-box; transform-origin: center; }

.el-l-move { animation-name: el-lMove; }
.el-r-move { animation-name: el-rMove; }
.el-l-spin { animation-name: el-lSpin; }
.el-r-spin { animation-name: el-rSpin; }
.el-dot    { animation-name: el-dot; fill: currentColor; stroke: none; opacity: 0; }
.el-d2 { animation-delay: .15s; }
.el-d3 { animation-delay: .3s; }

@keyframes el-lMove {
        0% { transform: translate(0px, 0px); }
    2.206% { transform: translate(-4px, 0px); }
    4.412% { transform: translate(0px, 0px); }
    6.618% { transform: translate(-4px, 0px); }
    8.824% { transform: translate(0px, 0px); }
   11.029% { transform: translate(-4px, 0px); }
   13.235% { transform: translate(0px, 0px); }
   14.118% { transform: translate(0px, -5px); }
       15% { transform: translate(0px, 0px); }
   17.647% { transform: translate(0px, 0px); }
   18.529% { transform: translate(0px, -5px); }
   19.412% { transform: translate(0px, 0px); }
   22.059% { transform: translate(0px, 0px); }
   22.941% { transform: translate(-2px, 0px); }
   30.882% { transform: translate(-2px, 0px); }
   31.765% { transform: translate(0px, 0px); }
   36.471% { transform: translate(0px, 0px); }
   37.059% { transform: translate(1.5px, 0px); }
   37.647% { transform: translate(0px, 0px); }
   38.235% { transform: translate(1.5px, 0px); }
   38.824% { transform: translate(0px, 0px); }
   41.765% { transform: translate(0px, 0px); }
   43.971% { transform: translate(-4px, 0px); }
   46.176% { transform: translate(0px, 0px); }
   48.382% { transform: translate(-4px, 0px); }
   50.588% { transform: translate(0px, 0px); }
   52.941% { transform: translate(0px, 0px); }
   55.147% { transform: translate(-4px, 0px); }
   57.353% { transform: translate(0px, 0px); }
   59.559% { transform: translate(-4px, 0px); }
   61.765% { transform: translate(0px, 0px); }
   67.059% { transform: translate(0px, 0px); }
   67.647% { transform: translate(1.5px, 0px); }
   68.235% { transform: translate(0px, 0px); }
   68.824% { transform: translate(1.5px, 0px); }
   69.412% { transform: translate(0px, 0px); }
   71.176% { transform: translate(0px, 0px); }
   73.529% { transform: translate(-2px, 0px); }
   74.706% { transform: translate(-2px, 0px); }
   75.882% { transform: translate(-2px, -3px); }
   77.059% { transform: translate(-2px, -3px); }
   78.235% { transform: translate(-2px, 3px); }
   79.412% { transform: translate(-2px, 3px); }
   80.588% { transform: translate(-2px, -3px); }
   81.765% { transform: translate(-2px, -3px); }
   82.941% { transform: translate(-2px, 0px); }
   86.471% { transform: translate(-2px, 0px); }
   87.647% { transform: translate(-2px, -3px); }
   88.824% { transform: translate(-2px, -3px); }
       90% { transform: translate(-2px, 3px); }
   91.176% { transform: translate(-2px, 3px); }
   92.353% { transform: translate(-2px, 0px); }
   92.941% { transform: translate(-2px, 0px); }
   95.294% { transform: translate(0px, 0px); }
      100% { transform: translate(0px, 0px); }
}
@keyframes el-rMove {
        0% { transform: translate(0px, 0px); }
    2.206% { transform: translate(4px, 0px); }
    4.412% { transform: translate(0px, 0px); }
    6.618% { transform: translate(4px, 0px); }
    8.824% { transform: translate(0px, 0px); }
   11.029% { transform: translate(4px, 0px); }
   13.235% { transform: translate(0px, 0px); }
   15.441% { transform: translate(0px, 0px); }
   16.324% { transform: translate(0px, -5px); }
   17.206% { transform: translate(0px, 0px); }
   19.853% { transform: translate(0px, 0px); }
   20.735% { transform: translate(0px, -5px); }
   21.618% { transform: translate(0px, 0px); }
   22.059% { transform: translate(0px, 0px); }
   22.941% { transform: translate(2px, 0px); }
   30.882% { transform: translate(2px, 0px); }
   31.765% { transform: translate(0px, 0px); }
   36.471% { transform: translate(0px, 0px); }
   37.059% { transform: translate(-1.5px, 0px); }
   37.647% { transform: translate(0px, 0px); }
   38.235% { transform: translate(-1.5px, 0px); }
   38.824% { transform: translate(0px, 0px); }
   41.765% { transform: translate(0px, 0px); }
   43.971% { transform: translate(4px, 0px); }
   46.176% { transform: translate(0px, 0px); }
   48.382% { transform: translate(4px, 0px); }
   50.588% { transform: translate(0px, 0px); }
   52.941% { transform: translate(0px, 0px); }
   55.147% { transform: translate(4px, 0px); }
   57.353% { transform: translate(0px, 0px); }
   59.559% { transform: translate(4px, 0px); }
   61.765% { transform: translate(0px, 0px); }
   67.059% { transform: translate(0px, 0px); }
   67.647% { transform: translate(-1.5px, 0px); }
   68.235% { transform: translate(0px, 0px); }
   68.824% { transform: translate(-1.5px, 0px); }
   69.412% { transform: translate(0px, 0px); }
   71.176% { transform: translate(0px, 0px); }
   73.529% { transform: translate(2px, 0px); }
   74.706% { transform: translate(2px, 0px); }
   75.882% { transform: translate(2px, 3px); }
   77.059% { transform: translate(2px, 3px); }
   78.235% { transform: translate(2px, -3px); }
   79.412% { transform: translate(2px, -3px); }
   80.588% { transform: translate(2px, 3px); }
   81.765% { transform: translate(2px, 3px); }
   82.941% { transform: translate(2px, 0px); }
   86.471% { transform: translate(2px, 0px); }
   87.647% { transform: translate(2px, 3px); }
   88.824% { transform: translate(2px, 3px); }
       90% { transform: translate(2px, -3px); }
   91.176% { transform: translate(2px, -3px); }
   92.353% { transform: translate(2px, 0px); }
   92.941% { transform: translate(2px, 0px); }
   95.294% { transform: translate(0px, 0px); }
      100% { transform: translate(0px, 0px); }
}
@keyframes el-lSpin {
        0% { transform: rotate(0deg) scale(1); }
   31.765% { transform: rotate(0deg) scale(1); }
   33.824% { transform: rotate(-180deg) scale(0.75); }
   35.882% { transform: rotate(-360deg) scale(1); }
   50.588% { transform: rotate(-360deg) scale(1); }
   52.941% { transform: rotate(-180deg) scale(1); }
   61.765% { transform: rotate(-180deg) scale(1); }
   64.118% { transform: rotate(-450deg) scale(0.75); }
   66.471% { transform: rotate(-720deg) scale(1); }
   71.176% { transform: rotate(-720deg) scale(1); }
   73.529% { transform: rotate(-630deg) scale(0.8); }
   83.529% { transform: rotate(-630deg) scale(0.8); }
   85.882% { transform: rotate(-450deg) scale(0.8); }
   92.941% { transform: rotate(-450deg) scale(0.8); }
   95.294% { transform: rotate(-360deg) scale(1); }
      100% { transform: rotate(-360deg) scale(1); }
}
@keyframes el-rSpin {
        0% { transform: rotate(0deg) scale(1); }
   31.765% { transform: rotate(0deg) scale(1); }
   33.824% { transform: rotate(180deg) scale(0.75); }
   35.882% { transform: rotate(360deg) scale(1); }
   50.588% { transform: rotate(360deg) scale(1); }
   52.941% { transform: rotate(180deg) scale(1); }
   61.765% { transform: rotate(180deg) scale(1); }
   64.118% { transform: rotate(450deg) scale(0.75); }
   66.471% { transform: rotate(720deg) scale(1); }
   71.176% { transform: rotate(720deg) scale(1); }
   73.529% { transform: rotate(630deg) scale(0.8); }
   83.529% { transform: rotate(630deg) scale(0.8); }
   85.882% { transform: rotate(450deg) scale(0.8); }
   92.941% { transform: rotate(450deg) scale(0.8); }
   95.294% { transform: rotate(360deg) scale(1); }
      100% { transform: rotate(360deg) scale(1); }
}
@keyframes el-dot {
        0% { opacity: 0; transform: translateY(0) scale(0); }
   22.941% { opacity: 0; transform: translateY(0) scale(0); }
   23.824% { opacity: 1; transform: translateY(0) scale(1.3); }
   24.412% { transform: translateY(0) scale(1); }
   25.588% { transform: translateY(-2.5px) scale(1); }
   26.765% { transform: translateY(0) scale(1); }
   27.941% { transform: translateY(-2.5px) scale(1); }
   29.118% { transform: translateY(0) scale(1); }
   29.706% { opacity: 1; transform: translateY(0) scale(1.3); }
   30.588% { opacity: 0; transform: translateY(0) scale(0); }
      100% { opacity: 0; transform: translateY(0) scale(0); }
}
@keyframes el-calm { 50% { opacity: .45; } }

/* Reduced motion: replace the show with a calm pulse */
@media (prefers-reduced-motion: reduce) {
  .el-anim { animation: none; }
  .el-root { animation: el-calm 2s ease-in-out infinite; }
}
`;

export function EigenLoader({ className }: EigenLoaderProps) {
    return (
        <svg
            className={cn('inline text-muted-foreground', className)}
            height="1em"
            viewBox="0 -8 28 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label="Loading"
        >
            <style>{css}</style>

            <g className="el-root">
                <g className="el-anim el-l-move">
                    <g className="el-anim el-spin el-l-spin">
                        <path d="m12 0 -4 7.5 4 7.5" />
                    </g>
                </g>
                <g className="el-anim el-r-move">
                    <g className="el-anim el-spin el-r-spin">
                        <path d="m16 0 4 7.5 -4 7.5" />
                    </g>
                </g>
                <circle className="el-anim el-dot" cx="12" cy="7.5" r=".9" />
                <circle className="el-anim el-dot el-d2" cx="14" cy="7.5" r=".9" />
                <circle className="el-anim el-dot el-d3" cx="16" cy="7.5" r=".9" />
            </g>
        </svg>
    );
}
