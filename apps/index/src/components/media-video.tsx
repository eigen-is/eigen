// A looping video from the site's Markdown, a short muted film that shows something happening. MediaVideo is the
// `::: video` block, the film over its caption, and LoopingVideo the film alone, which a carousel shows on a slide.
// The markup has no autoplay, so the server render holds still: the film starts from an effect while its caller says
// it is in view, and holds still with controls for a reader who asked for less motion. A click opens it bigger.

import { useMediaQuery } from '@workspace/lib/media';
import { useEffect, useRef, useState } from 'react';
import type { MediaVideoData } from '../../scripts/lib/content-types';
import type { LightboxItem, OpenLightbox } from './media-lightbox';

const AV1 = 'video/mp4; codecs="av01.0.08M.08"';

export function MediaVideo({ src, caption, onOpen }: MediaVideoData & { onOpen: OpenLightbox }) {
    return (
        <figure className="media-video">
            <LoopingVideo src={src} playing onClick={() => onOpen([loopingVideoItem(src, caption?.text)], 0)} />
            {/* Safe: build-time-rendered HTML from trusted, in-repo Markdown. */}
            {caption && <figcaption dangerouslySetInnerHTML={{ __html: caption.html }} />}
        </figure>
    );
}

type LoopingVideoProps = { src: string; playing: boolean; onClick: () => void };

export function LoopingVideo({ src, playing, onClick }: LoopingVideoProps) {
    const ref = useRef<HTMLVideoElement>(null);
    const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const [refused, setRefused] = useState(false);

    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        if (reduceMotion || !playing) {
            video.pause();
            return;
        }
        // A pause before playback starts rejects the play too, with an AbortError: only a NotAllowedError is a refusal.
        video.play().catch((error) => {
            if (error instanceof DOMException && error.name === 'NotAllowedError') setRefused(true);
        });
    }, [reduceMotion, playing]);

    // Every video stays within AV1 level 4.0, about 2048×1088, so a browser that says yes to it can decode it.
    return (
        <video
            ref={ref}
            muted
            loop
            playsInline
            preload="metadata"
            poster={`${src}.webp`}
            controls={reduceMotion || refused}
            onClick={onClick}
        >
            <source src={`${src}.av1.mp4`} type={AV1} />
            <source src={`${src}.h264.mp4`} type="video/mp4" />
        </video>
    );
}

// The lightbox plays one file: the one the browser picks from the two sources.
export function loopingVideoItem(src: string, caption?: string): LightboxItem {
    const codec = document.createElement('video').canPlayType(AV1) ? 'av1' : 'h264';
    return { type: 'video', src: `${src}.${codec}.mp4`, poster: `${src}.webp`, caption, loop: true };
}
