import { Button, Card as FluentCard, Caption1, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import type { Strings } from '../../shared/i18n';
import type { ConsentState, MateAction, MateLeave } from '../../shared/teammateIpc';
import { useSurfaceStyles } from './Bubble';
import { consentKey, consentMore, PutGuard } from './cardText';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

type Ui = Strings['teammate']['ui'];

const useStyles = makeStyles({
  card: {
    position: 'relative',
    overflow: 'hidden',
    width: '360px',
    boxSizing: 'border-box',
    padding: '12px 12px 14px',
    rowGap: '8px',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  /** An agent's question can hold a long path or address with no spaces to break at. */
  text: { fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  /** What will be pasted: quiet, and scrollable with the wheel when it is long. */
  detail: {
    maxHeight: '96px',
    overflowY: 'auto',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  /** Said outside the detail box, so it shows however long the detail is. */
  note: { color: tokens.colorNeutralForeground2 },
  buttons: { display: 'flex', flexWrap: 'wrap', columnGap: '6px', rowGap: '6px' },
  /** The time left to decide, along the card's bottom edge. */
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '3px',
    backgroundColor: tokens.colorBrandBackground,
    transformOrigin: 'left',
    animationName: { from: { transform: 'scaleX(1)' }, to: { transform: 'scaleX(0)' } },
    animationFillMode: 'forwards',
  },
});

/**
 * "Paste this into Chrome?" Allow once, Always allow (when offered) and Decline. The countdown only draws the time
 * left; the card closes when the caller says so. The window never takes the keyboard, so the buttons are clicked.
 */
export function Consent({ s, t, act, leaving }: {
  s: ConsentState; t: Ui; act: (a: MateAction) => void; leaving: MateLeave | null;
}) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const [guard] = useState(() => new PutGuard(() => performance.now()));
  guard.show(consentKey(s));
  // The card is already decided while it leaves, and a click within its first moments was meant for what was there
  // before: neither is an answer.
  const send = (a: MateAction): void => {
    if (!leaving && guard.click()) act(a);
  };
  // Main drops a click whose serial isn't the card on screen now.
  const serial = s.serial ?? 0;
  const left = s.side === 'left';
  const enter = left ? m.slideInLeft : m.slideInRight;
  const leave = leaving ? (left ? m.slideOutLeft : m.slideOutRight) : undefined;
  // What the detail left out is said outside its box, where scrolling can't hide it.
  const more = consentMore(s, t);
  // With reduced motion the bar ticks once a second instead of sliding.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div className={sf.frame}>
      <FluentCard className={mergeClasses(sf.surface, st.card, enter, leave)}>
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={false} thinkingLabel={t.thinking} />
        </div>
        <Text className={st.text}>{s.text}</Text>
        {s.detail && <Caption1 className={st.detail}>{s.detail}</Caption1>}
        {more && <Caption1 className={st.note}>{more}</Caption1>}
        {s.alwaysAsks && <Caption1 className={st.note}>{t.agentAlwaysAsks}</Caption1>}
        <div className={st.buttons}>
          <Button size="small" appearance="primary" onClick={() => send({ t: 'allow', serial })}>{t.allowOnce}</Button>
          {s.always && <Button size="small" onClick={() => send({ t: 'always', serial })}>{t.alwaysAllow}</Button>}
          <Button size="small" onClick={() => send({ t: 'decline', serial })}>{t.decline}</Button>
        </div>
        <div
          className={st.bar}
          aria-hidden
          style={{
            animationDuration: `${s.seconds}s`,
            animationTimingFunction: reduced ? `steps(${Math.max(1, Math.round(s.seconds))}, end)` : 'linear',
          }}
        />
      </FluentCard>
    </div>
  );
}
