import { makeStyles, tokens } from '@fluentui/react-components';

/** Reduce motion (Windows animation effects off, macOS Reduce motion) turns every animation here off. */
const REDUCED = '@media (prefers-reduced-motion: reduce)';
const still = { [REDUCED]: { animationName: 'none' } };

/**
 * The teammate's motion (spec §7.6), on Fluent's duration and curve tokens. Motion never delays content: elements
 * are in the page at once and only their arrival animates. Nothing loops except the thinking dots.
 */
export const useMotion = makeStyles({
  /** Bubble appears: fade and rise 8 px. */
  appear: {
    animationName: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    ...still,
  },
  /** Card grows from the bubble's corner. */
  grow: {
    transformOrigin: 'top left',
    animationName: { from: { opacity: 0, transform: 'scale(0.96)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationGentle,
    animationTimingFunction: tokens.curveDecelerateMid,
    ...still,
  },
  /** Card closes toward the spot. */
  shrink: {
    transformOrigin: 'top left',
    animationName: { from: { opacity: 1, transform: 'none' }, to: { opacity: 0, transform: 'scale(0.98)' } },
    animationDuration: tokens.durationFast,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  /** Bubble leaves when the card opens or it is closed. */
  fadeOut: {
    animationName: { from: { opacity: 1 }, to: { opacity: 0 } },
    animationDuration: tokens.durationFast,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  /** A stale signal: the slow fade. */
  stale: {
    animationName: { from: { opacity: 1 }, to: { opacity: 0 } },
    animationDuration: '600ms',
    animationTimingFunction: tokens.curveEasyEase,
    animationFillMode: 'forwards',
    ...still,
  },
  /** Streamed words and new answers fade in. */
  fadeIn: {
    animationName: { from: { opacity: 0 }, to: { opacity: 1 } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    ...still,
  },
  /** History rows slide in as they come into the list. */
  slideIn: {
    animationName: { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    ...still,
  },
  /** One of the three thinking dots in the name tag; the only loop. */
  dot: {
    display: 'inline-block',
    width: '4px',
    height: '4px',
    marginLeft: '3px',
    borderRadius: '50%',
    backgroundColor: 'currentColor',
    opacity: 0.4,
    animationName: { '0%, 100%': { opacity: 0.25 }, '50%': { opacity: 1 } },
    animationDuration: '1200ms',
    animationIterationCount: 'infinite',
    animationTimingFunction: tokens.curveEasyEase,
    ':nth-child(2)': { animationDelay: '200ms' },
    ':nth-child(3)': { animationDelay: '400ms' },
    [REDUCED]: { animationName: 'none', opacity: 0.7 },
  },
});
