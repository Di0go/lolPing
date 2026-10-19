import {
  Button, Caption1, Card as FluentCard, Input, makeStyles, mergeClasses, Subtitle2, Text, tokens,
} from '@fluentui/react-components';
import { Copy16Regular, Dismiss16Regular, History16Regular, Send16Regular } from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Strings } from '../../shared/i18n';
import { MATE_TEXT_MAX, type CardState, type MateAction, type MateLeave } from '../../shared/teammateIpc';
import { useSurfaceStyles } from './Bubble';
import { copyAllText, footerText } from './cardText';
import { renderMarkdown } from './markdown';
import { useMotion } from './motion';
import { NameTag } from './NameTag';

type Ui = Strings['teammate']['ui'];

const COPIED_MS = 1500;

const useStyles = makeStyles({
  card: {
    width: '456px',
    maxHeight: '576px',
    boxSizing: 'border-box',
    padding: '10px 6px 8px 12px',
    rowGap: '8px',
  },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  title: { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: {
    flexShrink: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '6px',
    display: 'flex',
    flexDirection: 'column',
    rowGap: '10px',
  },
  entry: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  label: { color: tokens.colorNeutralForeground3 },
  ask: { color: tokens.colorNeutralForeground2, whiteSpace: 'pre-wrap' },
  buttons: { display: 'flex', flexWrap: 'wrap', columnGap: '4px', rowGap: '4px', paddingRight: '6px' },
  reply: { marginRight: '6px' },
  footer: { color: tokens.colorNeutralForeground3, paddingRight: '6px' },
});

/** The model's Markdown, sanitised; web links become `link` actions and code blocks get a Copy button. */
function Markdown({ md, t, act }: { md: string; t: Ui; act: (a: MateAction) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(md), [md]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    for (const link of el.querySelectorAll('[data-link]')) {
      link.setAttribute('role', 'link');
      link.setAttribute('tabindex', '0');
    }
    for (const pre of el.querySelectorAll('pre')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mate-copy-code';
      b.textContent = t.copyCode;
      pre.append(b);
    }
  }, [html, t]);
  const activate = (target: EventTarget): boolean => {
    if (!(target instanceof Element)) return false;
    const copy = target.closest('.mate-copy-code');
    if (copy) {
      act({ t: 'copy', text: copy.parentElement?.querySelector('code')?.textContent ?? '' });
      return true;
    }
    const url = target.closest('[data-link]')?.getAttribute('data-link');
    if (url) act({ t: 'link', url });
    return Boolean(url);
  };
  const onClick = (e: MouseEvent): void => {
    if (activate(e.target)) e.preventDefault();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && e.target instanceof Element && e.target.hasAttribute('data-link') && activate(e.target)) {
      e.preventDefault();
    }
  };
  return <div ref={ref} className="mate-md" onClick={onClick} onKeyDown={onKeyDown} />;
}

export function Card({ s, t, act, leaving }: { s: CardState; t: Ui; act: (a: MateAction) => void; leaving: MateLeave | null }) {
  const st = useStyles();
  const sf = useSurfaceStyles();
  const m = useMotion();
  const [reply, setReply] = useState('');
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Entries the card opened with are there at once; each one added later fades in (once: keys are stable).
  const fresh = useRef(s.entries.length).current;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) act({ t: 'close' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act]);

  // While the answer streams in, keep its end in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && s.streaming) el.scrollTop = el.scrollHeight;
  }, [s]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const sendReply = (): void => {
    const text = reply.trim();
    if (!text) return;
    act({ t: 'reply', text });
    setReply('');
  };
  const copyAll = (): void => {
    act({ t: 'copy', text: copyAllText(s.entries) });
    setCopied(true);
  };
  const leave = leaving === 'stale' ? m.stale : leaving === 'fast' ? m.shrink : undefined;
  return (
    <div className={sf.frame}>
      <FluentCard className={mergeClasses(sf.surface, st.card, m.grow, leave)}>
        <div className={st.head}>
          <NameTag tag={s.tag} thinking={s.streaming} thinkingLabel={t.thinking} />
          <Subtitle2 className={st.title}>{s.title}</Subtitle2>
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            aria-label={t.close}
            onClick={() => act({ t: 'close' })}
          />
        </div>
        <div className={st.body} ref={bodyRef}>
          {s.entries.map((e, i) => (
            <div key={i} className={mergeClasses(st.entry, i >= fresh && m.fadeIn)}>
              <Caption1 className={st.label}>{e.label}</Caption1>
              {e.kind === 'ask' ? <Text className={st.ask}>{e.markdown}</Text> : <Markdown md={e.markdown} t={t} act={act} />}
            </div>
          ))}
        </div>
        <div className={st.buttons}>
          <Button size="small" icon={<Copy16Regular />} onClick={copyAll}>
            {copied ? t.copied : t.copy}
          </Button>
          <Button size="small" onClick={() => act({ t: 'deep' })}>
            {t.wholePicture}
          </Button>
          <Button size="small" icon={<History16Regular />} onClick={() => act({ t: 'history' })}>
            {t.history}
          </Button>
        </div>
        <Input
          className={st.reply}
          size="small"
          placeholder={t.reply}
          value={reply}
          maxLength={MATE_TEXT_MAX}
          onChange={(_e, d) => setReply(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendReply();
          }}
          contentAfter={
            <Button size="small" appearance="transparent" icon={<Send16Regular />} aria-label={t.send} onClick={sendReply} />
          }
        />
        <Caption1 className={st.footer}>{footerText(s.footer, t)}</Caption1>
      </FluentCard>
    </div>
  );
}
