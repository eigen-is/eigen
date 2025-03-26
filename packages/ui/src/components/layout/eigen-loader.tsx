import {cn} from '../../lib/utils';
import {useEffect, useState} from 'react';

type EigenLoadingScreenProps = {
    className?: string;
};

// CSS animaties gebruikt als string literals
const animationStyles = {
    moveLeftChevron: `
    @keyframes moveLeftChevron {
      0%, 100% { transform: translateX(-6px); }
      50% { transform: translateX(-12px); }
    }
  `,
    moveRightChevron: `
    @keyframes moveRightChevron {
      0%, 100% { transform: translateX(6px); }
      50% { transform: translateX(12px); }
    }
  `
};

export function EigenLoader({className}: EigenLoadingScreenProps) {
    // State om bij te houden of de animatie is gestart
    const [animationStarted, setAnimationStarted] = useState(false);

    // Start animatie effect
    useEffect(() => {
        // Korte vertraging voordat we de animatie starten voor een betere visuele ervaring
        const timer = setTimeout(() => {
            setAnimationStarted(true);
        }, 300);

        return () => clearTimeout(timer);
    }, []);

    return (
        <>
            {/* Voeg de keyframe animaties toe via een style tag */}
            <style>
                {animationStyles.moveLeftChevron}
                {animationStyles.moveRightChevron}
            </style>

            <div className={cn("relative text-muted-foreground",
                className
            )}>
                {/* Left Chevron */}
                <svg
                    className="h-8 w-8 absolute"
                    style={{
                        left: '-10px',
                        animation: animationStarted ? 'moveLeftChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m9 7-5 5 5 5"/>
                </svg>

                {/* Right Chevron */}
                <svg
                    className="h-8 w-8 absolute"
                    style={{
                        right: '-10px',
                        animation: animationStarted ? 'moveRightChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m15 7 5 5-5 5"/>
                </svg>
            </div>
        </>
    );
}
