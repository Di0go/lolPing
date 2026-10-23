import { Button, Card as FluentCard, Caption1, Checkbox, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import type { LeftField } from '../../shared/teammate/doRules';
import type { Strings } from '../../shared/i18n';
import type { FormState, MateAction, MateLeave } from '../../shared/teammateIpc';
import { useSurfaceStyles } from './Bubble';
import { formKey, PutGuard } from './cardText';
import { checkedIds } from './formChoice';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

type Ui = Strings['teammate']['ui'];

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    width: '396px',
    // The window is at most 520 DIPs high, with 12 on each side for the shadow: past this the list scrolls.
    maxHeight: '496px',
    boxSizing: 'border-box',
    padding: '12px 12px 10px',
    rowGap: '8px',
    overflow: 'hidden',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  text: { fontWeight: tokens.fontWeightSemibold },
  /** The rows and the fields left for the user; the wheel scrolls it, and the buttons stay below it. */
  list: { flexShrink: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', rowGap: '2px' },
  label: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  /** Two lines at most; the whole value is the row's tooltip. */
  value: {
    color: tokens.colorNeutralForeground2,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: '2',
    overflow: 'hidden',
  },
  leftHead: { color: tokens.colorNeutralForeground3, marginTop: '6px' },
  leftRow: { paddingLeft: '8px', overflowWrap: 'anywhere' },
  reason: { color: tokens.colorNeutralForeground3 },
  buttons: { display: 'flex', flexWrap: 'wrap', columnGap: '6px', rowGap: '6px' },
  note: { color: tokens.colorNeutralForeground3 },
});

const reasonText = (t: Ui, reason: LeftField['reason']): string => {
  switch (reason) {
    case 'secure':
      return t.formWhySecure;
    case 'unknown':
      return t.formWhyUnknown;
    case 'kind':
      return t.formWhyKind;
    case 'option':
      return t.formWhyOption;
  }
};

/**
 * "Fill this form in Chrome?" The fields it will fill, each with a checkbox, the fields left for the user, and Fill and
 * Cancel. The window never takes the keyboard, so everything is clicked; the wheel scrolls a long list.
 */
export function FormPreview({ s, t, act, leaving }: {
  s: FormState; t: Ui; act: (a: MateAction) => void; leaving: MateLeave | null;
}) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  // What the user ticked or cleared; a row nobody touched keeps the state's own tick.
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const ids = checkedIds(s.rows, choice);
  const [guard] = useState(() => new PutGuard(() => performance.now()));
  guard.show(formKey(s));
  // The preview is already decided while it leaves, and a click within its first moments was meant for what was there
  // before: neither is an answer. A fill can't be undone.
  const send = (a: MateAction): void => {
    if (!leaving && guard.click()) act(a);
  };
  // Main drops a click whose serial isn't the preview on screen now.
  const serial = s.serial ?? 0;
  const left = s.side === 'left';
  const enter = left ? m.slideInLeft : m.slideInRight;
  const leave = leaving ? (left ? m.slideOutLeft : m.slideOutRight) : undefined;
  return (
    <div className={sf.frame}>
      <FluentCard className={mergeClasses(sf.surface, st.card, enter, leave)}>
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={false} thinkingLabel={t.thinking} />
        </div>
        <Text className={st.text}>{t.formTitle(s.app)}</Text>
        <div className={st.list}>
          {s.rows.map((r) => (
            <Checkbox
              key={r.id}
              title={r.value}
              checked={ids.includes(r.id)}
              onChange={(_e, d) => setChoice((c) => ({ ...c, [r.id]: d.checked === true }))}
              label={{
                children: (
                  <span className={st.label}>
                    <Text className={st.name}>{r.label}</Text>
                    <Caption1 className={st.value}>{r.value}</Caption1>
                  </span>
                ),
              }}
            />
          ))}
          {s.left.length > 0 && (
            <>
              <Caption1 className={st.leftHead}>{t.formLeft}</Caption1>
              {s.left.map((f, i) => (
                <div key={i} className={st.leftRow}>
                  <Caption1>
                    {f.label}
                    <span className={st.reason}>{t.sep}{reasonText(t, f.reason)}</span>
                  </Caption1>
                </div>
              ))}
            </>
          )}
        </div>
        <div className={st.buttons}>
          <Button
            size="small"
            appearance="primary"
            disabled={ids.length === 0}
            onClick={() => send({ t: 'fill', ids, serial })}
          >
            {t.formFill(ids.length)}
          </Button>
          <Button size="small" onClick={() => send({ t: 'cancel', serial })}>{t.formCancel}</Button>
        </div>
        <Caption1 className={st.note}>{t.formNote}</Caption1>
      </FluentCard>
    </div>
  );
}
