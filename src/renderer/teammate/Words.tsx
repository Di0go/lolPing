import { Caption1, Input, makeStyles, mergeClasses, Switch, tokens } from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import type { Strings } from '../../shared/i18n';
import { MATE_TEXT_MAX, type MateAction, type WordsState } from '../../shared/teammateIpc';
import { useSurfaceStyles } from './Bubble';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

const useStyles = makeStyles({
  box: { padding: '8px 10px', display: 'flex', flexDirection: 'column', rowGap: '6px' },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0, minHeight: '24px' },
  thread: {
    flexGrow: 1,
    minWidth: 0,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spacer: { flexGrow: 1 },
  switch: { flexShrink: 0 },
});

/** Ask with typed words at the spot: Enter asks, Esc cancels (losing focus cancels too, in the main process). */
export function Words({ s, t, act }: { s: WordsState; t: Strings['teammate']['ui']; act: (a: MateAction) => void }) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const [text, setText] = useState('');
  // With no current thread every ask starts one, so there is no switch.
  const [newThread, setNewThread] = useState(!s.continueByDefault);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const ask = (): void => {
    const words = text.trim();
    if (words) act({ t: 'ask', text: words, newThread: s.thread === null || newThread });
  };
  return (
    <div className={sf.frame}>
      <div className={mergeClasses(sf.surface, st.box, m.appear)}>
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={false} thinkingLabel={t.thinking} />
          {s.thread ? (
            <>
              <Caption1 className={st.thread}>↳ {s.thread}</Caption1>
              <Switch
                className={st.switch}
                label={t.newThread}
                checked={newThread}
                onChange={(_e, d) => {
                  setNewThread(d.checked);
                  input.current?.focus();
                }}
              />
            </>
          ) : (
            <span className={st.spacer} />
          )}
        </div>
        <Input
          ref={input}
          placeholder={t.ask}
          value={text}
          maxLength={MATE_TEXT_MAX}
          onChange={(_e, d) => setText(d.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') ask();
            else if (e.key === 'Escape') act({ t: 'cancel' });
          }}
        />
      </div>
    </div>
  );
}
