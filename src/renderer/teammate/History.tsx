import {
  Body1Strong, Button, Caption1, makeStyles, mergeClasses, SearchBox, Subtitle1, Text, tokens,
} from '@fluentui/react-components';
import { Delete16Regular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Strings } from '../../shared/i18n';
import type { HistoryState, MateAction } from '../../shared/teammateIpc';
import { groupByDay, type Day } from './historyDays';
import { useMotion } from './motion';

/** Typing pauses this long before the list is searched again. */
const SEARCH_WAIT_MS = 150;

const useStyles = makeStyles({
  page: {
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
  },
  search: { maxWidth: '360px' },
  day: { marginTop: '8px', color: tokens.colorNeutralForeground3 },
  row: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '12px',
    padding: '8px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  text: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  note: { color: tokens.colorNeutralForeground2 },
});

export function History({ s, t, act }: { s: HistoryState; t: Strings; act: (a: MateAction) => void }) {
  const st = useStyles();
  const m = useMotion();
  const ui = t.teammate.ui;
  const [query, setQuery] = useState(s.query);
  const sent = useRef(s.query);

  useEffect(() => {
    if (query === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = query;
      act({ t: 'search', query });
    }, SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [query, act]);

  const groups = useMemo(() => groupByDay(s.threads, Date.now()), [s.threads]);
  const dayName = (day: Day): string =>
    day === 'today' ? ui.today
      : day === 'yesterday' ? ui.yesterday
        : new Intl.DateTimeFormat(s.lang, { dateStyle: 'full' }).format(day);
  const time = new Intl.DateTimeFormat(s.lang, { timeStyle: 'short' });

  return (
    <div className={st.page}>
      <Subtitle1>{ui.historyTitle}</Subtitle1>
      {!s.available ? (
        <Text className={st.note}>{s.off === 'unavailable' ? ui.historyUnavailable : ui.historyDisabled}</Text>
      ) : (
        <>
          <SearchBox
            className={st.search}
            placeholder={ui.search}
            aria-label={ui.search}
            value={query}
            maxLength={200}
            onChange={(_e, d) => setQuery(d.value)}
          />
          {groups.length === 0 && <Text className={st.note}>{s.query ? ui.noMatch : ui.noThreads}</Text>}
          {groups.map((g) => (
            <section key={String(g.day)}>
              <Body1Strong className={st.day}>{dayName(g.day)}</Body1Strong>
              {g.threads.map((th) => (
                <div key={th.id} className={mergeClasses(st.row, m.slideIn)} style={{ marginTop: 6 }}>
                  <div className={st.text}>
                    <Text weight="semibold" className={st.ellipsis}>{th.title}</Text>
                    <Caption1 className={mergeClasses(st.meta, st.ellipsis)}>
                      {[time.format(th.lastActivity), th.app, ...th.intents.map((id) => t.teammate.intent[id].label)]
                        .filter(Boolean)
                        .join(' · ')}
                    </Caption1>
                  </div>
                  <Button size="small" onClick={() => act({ t: 'open', id: th.id })}>{ui.open}</Button>
                  <Button size="small" appearance="primary" onClick={() => act({ t: 'continue', id: th.id })}>
                    {ui.continueThread}
                  </Button>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Delete16Regular />}
                    aria-label={ui.delete}
                    title={ui.delete}
                    onClick={() => act({ t: 'delete', id: th.id })}
                  />
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
