// From https://motion-primitives.com/c/text-shimmer.json (motion-primitives, MIT). Colours are Livery tokens instead of zinc and
// the dark block; with reduced motion the text stays still.
import { memo, useMemo } from 'react';
import type { CSSProperties, ElementType, JSX, ReactElement } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils.js';

export type TextShimmerProps = { children: string; as?: ElementType; className?: string; duration?: number; spread?: number };

function TextShimmerComponent({ children, as: Component = 'p', className, duration = 2, spread = 2 }: TextShimmerProps): ReactElement {
  const still = useReducedMotion() === true;
  // made once per element type, not on every render (the original made a new component each time, which remounts it)
  const MotionComponent = useMemo(() => motion.create(Component as keyof JSX.IntrinsicElements), [Component]);
  if (still) return <Component className={cn('text-muted-foreground', className)}>{children}</Component>;
  return (
    <MotionComponent
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [--base-color:var(--muted)] [--base-gradient-color:var(--text)]',
        '[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,transparent_calc(50%-var(--spread)),var(--base-gradient-color),transparent_calc(50%+var(--spread)))]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      animate={{ backgroundPosition: '0% center' }}
      transition={{ repeat: Number.POSITIVE_INFINITY, duration, ease: 'linear' }}
      style={{ '--spread': `${children.length * spread}px`, backgroundImage: 'var(--bg), linear-gradient(var(--base-color), var(--base-color))' } as CSSProperties}
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = memo(TextShimmerComponent);
