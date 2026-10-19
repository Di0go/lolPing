import { Button, Caption1, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import type { Strings } from '../../shared/i18n';
import type { BubbleState, MateAction, MateLeave } from '../../shared/teammateIpc';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

export const useSurfaceStyles = makeStyles({
  /** Room around the surface for its shadow: the window is transparent there. */
  frame: { padding: '12px' },
  surface: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
    border: `1px solid ${tokens.colorTransparentStroke}`,
  },
});

const useStyles = makeStyles({
  bubble: {
    maxWidth: '416px',
    padding: '8px 6px 8px 10px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '4px',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: '6px', minWidth: 0 },
  thread: {
    flexGrow: 1,
    minWidth: 0,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spacer: { flexGrow: 1 },
  body: { display: 'flex', alignItems: 'flex-end', columnGap: '6px', paddingRight: '4px' },
  line: { flexGrow: 1 },
});

export function Bubble({ s, t, act, leaving }: {
  s: BubbleState; t: Strings['teammate']['ui']; act: (a: MateAction) => void; leaving: MateLeave | null;
}) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const leave = leaving === 'stale' ? m.stale : leaving === 'fast' ? m.fadeOut : undefined;
  return (
    <div className={sf.frame}>
      <div className={mergeClasses(sf.surface, st.bubble, m.appear, leave)}>
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={s.thinking} thinkingLabel={t.thinking} />
          {s.thread ? <Caption1 className={st.thread}>↳ {s.thread}</Caption1> : <span className={st.spacer} />}
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={t.dismiss}
            onClick={() => act({ t: 'dismiss' })}
          />
        </div>
        {(s.line || s.more) && (
          <div className={st.body}>
            <Text className={st.line}>{s.line}</Text>
            {s.more && (
              <Button size="small" appearance="primary" onClick={() => act({ t: 'more' })}>
                {t.more}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
