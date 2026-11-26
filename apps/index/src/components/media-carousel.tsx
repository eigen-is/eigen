// A carousel from the site's Markdown, its `::: carousel` block: pictures and looping videos on a strip the reader
// scrolls one slide at a time, by touch, by dragging it with the mouse, or with a dot per slide and previous and next
// buttons under it. The strip's scroll says which slide is in view, and that slide marks its dot, turns a button off
// at an end and is the one whose video plays. An autoplay carousel steps on by itself until the reader moves it. A
// click on a slide or its corner button, or Enter on the strip, opens the slide in the page's lightbox.

import { prefersReducedMotion } from '@workspace/ui/hooks/prefers-reduced-motion';
import { useDragScroll } from '@workspace/ui/hooks/use-drag-scroll';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { MediaCarouselData } from '../../scripts/lib/content-types';
import type { OpenLightbox } from './media-lightbox';
import { ExpandButton } from './media-lightbox';
import { LoopingVideo, loopingVideoItem } from './media-video';

const AUTOPLAY_MS = 7000;

export function MediaCarousel({ slides, autoplay, caption, onOpen }: MediaCarouselData & { onOpen: OpenLightbox }) {
    const carousel = useRef<HTMLElement>(null);
    const strip = useRef<HTMLDivElement>(null);
    const [current, setCurrent] = useState(0);
    const drag = useDragScroll();

    // It waits while the reader points at it or is inside it. It remembers the slide it scrolled to, so a strip on
    // any other slide is the reader's doing, and it stops for good.
    useEffect(() => {
        const figure = carousel.current;
        const scroller = strip.current;
        if (!autoplay || !figure || !scroller) return;
        let shown = 0;
        const timer = setInterval(() => {
            if (prefersReducedMotion() || document.hidden || figure.matches(':hover, :focus-within')) return;
            const { pitch, inView } = stripPosition(scroller);
            if (inView !== shown) return clearInterval(timer);
            shown = (inView + 1) % scroller.children.length;
            scroller.scrollTo({ left: shown * pitch });
        }, AUTOPLAY_MS);
        return () => clearInterval(timer);
    }, [autoplay]);

    const scrollTo = (slide: number) => {
        const scroller = strip.current;
        scroller?.scrollTo({ left: slide * stripPosition(scroller).pitch });
    };
    const open = (slide: number) => {
        const items = slides.map(({ type, src, caption }) =>
            type === 'video' ? loopingVideoItem(src, caption.text) : { type, src, caption: caption.text },
        );
        onOpen(items, slide);
    };
    // A film with controls keeps its own keys.
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open(current);
    };

    return (
        <figure ref={carousel} className="media-carousel">
            <div
                ref={strip}
                className="media-carousel-strip"
                tabIndex={0}
                aria-label={caption?.text ?? 'Slides'}
                data-dragging={drag.dragging || undefined}
                onScroll={(e) => setCurrent(stripPosition(e.currentTarget).inView)}
                onKeyDown={onKeyDown}
                {...drag.handlers}
            >
                {slides.map(({ type, src, caption }, i) => (
                    <figure key={i} className="media-carousel-slide">
                        <div className="media-frame">
                            {type === 'video' ? (
                                <LoopingVideo
                                    src={src}
                                    label={caption.text}
                                    playing={i === current}
                                    onClick={() => open(i)}
                                />
                            ) : (
                                <img src={src} alt={caption.text} onClick={() => open(i)} />
                            )}
                            <ExpandButton onClick={() => open(i)} />
                        </div>
                        {/* Safe: build-time-rendered HTML from trusted, in-repo Markdown. */}
                        <figcaption dangerouslySetInnerHTML={{ __html: caption.html }} />
                    </figure>
                ))}
            </div>
            <div className="media-carousel-nav">
                <div className="media-carousel-dots">
                    {slides.map((_, i) => (
                        <button
                            key={i}
                            type="button"
                            className="media-carousel-dot"
                            aria-label={`Slide ${i + 1} of ${slides.length}`}
                            aria-current={i === current ? 'true' : undefined}
                            onClick={() => scrollTo(i)}
                        />
                    ))}
                </div>
                <div className="media-carousel-steps">
                    <button
                        type="button"
                        className="media-carousel-prev"
                        aria-label="Previous slide"
                        disabled={current <= 0}
                        onClick={() => scrollTo(current - 1)}
                    >
                        <ChevronLeft size={20} />
                    </button>
                    <button
                        type="button"
                        className="media-carousel-next"
                        aria-label="Next slide"
                        disabled={current >= slides.length - 1}
                        onClick={() => scrollTo(current + 1)}
                    >
                        <ChevronRight size={20} />
                    </button>
                </div>
            </div>
            {caption && <figcaption dangerouslySetInnerHTML={{ __html: caption.html }} />}
        </figure>
    );
}

// The slides of a strip lie one pitch apart, so its scroll offset over the pitch is the slide in view.
function stripPosition(strip: HTMLElement) {
    const [first, second] = strip.querySelectorAll<HTMLElement>('.media-carousel-slide');
    const pitch = second ? second.offsetLeft - first.offsetLeft : strip.clientWidth;
    return { pitch, inView: Math.round(strip.scrollLeft / pitch) };
}
