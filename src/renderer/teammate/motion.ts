import { makeStyles, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';

/** Reduce motion (Windows animation effects off, macOS Reduce motion) turns every animation here off. */
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const REDUCED = `@media ${REDUCED_QUERY}`;

/** Whether motion is off right now; read it when needed, so a change of the OS setting counts at once. */
export const reducedMotion = (): boolean => matchMedia(REDUCED_QUERY).matches;
const still = { [REDUCED]: { animationName: 'none' } };

/** Delay between items that arrive together; the stagger stops growing after this many. */
const STAGGER_MS = 35;
const STAGGER_MAX = 10;

/** Inline style that makes the i-th of a set of arriving items start a little after the one before it. */
export const stagger = (i: number): CSSProperties => ({ animationDelay: `${Math.min(i, STAGGER_MAX) * STAGGER_MS}ms` });

/**
 * The teammate's motion (spec §7.6), on Fluent's duration and curve tokens. Motion never delays content: elements
 * are in the page at once and only their arrival animates. Nothing loops except the thinking dots.
 */
export const useMotion = makeStyles({
  /** Bubble and words box appear: they rise out of the spot below-left of them. */
  appear: {
    transformOrigin: 'bottom left',
    animationName: {
      from: { opacity: 0, transform: 'translateY(8px) scale(0.96)' },
      to: { opacity: 1, transform: 'none' },
    },
    animationDuration: tokens.durationGentle,
    animationTimingFunction: tokens.curveDecelerateMax,
    ...still,
  },
  /** Card grows out of the bubble's corner. */
  grow: {
    transformOrigin: 'top left',
    animationName: {
      from: { opacity: 0, transform: 'translateY(-4px) scale(0.94)' },
      to: { opacity: 1, transform: 'none' },
    },
    animationDuration: tokens.durationGentle,
    animationTimingFunction: tokens.curveDecelerateMax,
    ...still,
  },
  /** Card closes toward the spot. */
  shrink: {
    transformOrigin: 'top left',
    animationName: { from: { opacity: 1, transform: 'none' }, to: { opacity: 0, transform: 'scale(0.96)' } },
    animationDuration: tokens.durationFast,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  /** Bubble leaves when the card opens or it is closed: it sinks back toward the spot. */
  fadeOut: {
    transformOrigin: 'bottom left',
    animationName: {
      from: { opacity: 1, transform: 'none' },
      to: { opacity: 0, transform: 'translateY(4px) scale(0.98)' },
    },
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
  /** The consent card slides 12 px in from the side it sits on (spec §7.6); it leaves the same way. */
  slideInRight: {
    animationName: { from: { opacity: 0, transform: 'translateX(12px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMax,
    animationFillMode: 'both',
    ...still,
  },
  slideInLeft: {
    animationName: { from: { opacity: 0, transform: 'translateX(-12px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMax,
    animationFillMode: 'both',
    ...still,
  },
  slideOutRight: {
    animationName: { from: { opacity: 1, transform: 'none' }, to: { opacity: 0, transform: 'translateX(12px)' } },
    animationDuration: tokens.durationFast,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  slideOutLeft: {
    animationName: { from: { opacity: 1, transform: 'none' }, to: { opacity: 0, transform: 'translateX(-12px)' } },
    animationDuration: tokens.durationFast,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  /** A new line or entry settles in from just below; with `stagger`, one after another. */
  rise: {
    animationName: { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    animationFillMode: 'both',
    ...still,
  },
  /** History rows slide in as they come into the list; with `stagger`, one after another. */
  slideIn: {
    animationName: { from: { opacity: 0, transform: 'translateY(10px)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationGentle,
    animationTimingFunction: tokens.curveDecelerateMax,
    animationFillMode: 'both',
    ...still,
  },
  /** A row being deleted slides away before it goes. */
  slideOut: {
    animationName: { from: { opacity: 1, transform: 'none' }, to: { opacity: 0, transform: 'translateX(24px)' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveAccelerateMid,
    animationFillMode: 'forwards',
    ...still,
  },
  /** A button or icon that appears on its own (More, Copied) pops in. */
  pop: {
    animationName: {
      '0%': { opacity: 0, transform: 'scale(0.6)' },
      '70%': { opacity: 1, transform: 'scale(1.06)' },
      '100%': { opacity: 1, transform: 'none' },
    },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMid,
    animationFillMode: 'both',
    ...still,
  },
  /** One of the three thinking dots in the name tag; they hop one after another. */
  dot: {
    display: 'inline-block',
    width: '4px',
    height: '4px',
    marginLeft: '3px',
    borderRadius: '50%',
    backgroundColor: 'currentColor',
    opacity: 0.4,
    animationName: {
      '0%, 60%, 100%': { opacity: 0.35, transform: 'none' },
      '30%': { opacity: 1, transform: 'translateY(-3px)' },
    },
    animationDuration: '1200ms',
    animationIterationCount: 'infinite',
    animationTimingFunction: tokens.curveEasyEase,
    ':nth-child(2)': { animationDelay: '150ms' },
    ':nth-child(3)': { animationDelay: '300ms' },
    [REDUCED]: { animationName: 'none', opacity: 0.7 },
  },
});
