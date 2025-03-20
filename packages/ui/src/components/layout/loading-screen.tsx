import { cn } from '../../lib/utils';
import { useEffect, useState } from 'react';

type LoadingScreenProps = {
  className?: string;
};

// CSS animaties gebruikt als string literals
const animationStyles = {
  moveLeftChevron: `
    @keyframes moveLeftChevron {
      0%, 100% { transform: translateX(0); }
      50% { transform: translateX(-10px); }
    }
  `,
  moveRightChevron: `
    @keyframes moveRightChevron {
      0%, 100% { transform: translateX(0); }
      50% { transform: translateX(10px); }
    }
  `,
  moveLine: `
    @keyframes moveLine {
      0% { transform: translateX(-15px); width: 20px; }
      50% { transform: translateX(15px); width: 20px; }
      100% { transform: translateX(-15px); width: 20px; }
    }
  `
};

export function LoadingScreen({ className }: LoadingScreenProps) {
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
        {animationStyles.moveLine}
      </style>
      
      <div className={cn(
        "fixed inset-0 flex items-center justify-center bg-white", 
        className
      )}>
        <div className="relative flex items-center justify-center">
          {/* Left Chevron */}
          <svg 
            className="h-12 w-12 text-black absolute"
            style={{
              left: '-10px',
              animation: animationStarted ? 'moveLeftChevron 1.5s infinite ease-in-out' : 'none'
            }}
            width="24" 
            height="24" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          >
            <path d="m9 7-5 5 5 5" />
          </svg>

          {/* Moving Line */}
          <div
            className="h-1 bg-black absolute"
            style={{
              width: '20px',
              animation: animationStarted ? 'moveLine 1.5s infinite ease-in-out' : 'none'
            }}
          />

          {/* Right Chevron */}
          <svg 
            className="h-12 w-12 text-black absolute"
            style={{
              right: '-10px',
              animation: animationStarted ? 'moveRightChevron 1.5s infinite ease-in-out' : 'none'
            }}
            width="24" 
            height="24" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          >
            <path d="m15 7 5 5-5 5" />
          </svg>
        </div>
      </div>
    </>
  );
}
