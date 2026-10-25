import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { strings } from '../../shared/i18n';
import type { MateAction, MateLeave, MateState, MateView } from '../../shared/teammateIpc';
import { Bubble } from './Bubble';
import { Card } from './Card';
import { Consent } from './Consent';
import { HEIGHT_TARGET, heightStep } from './easedHeight';
import { FormPreview } from './FormPreview';
import { History } from './History';
import { reducedMotion } from './motion';
import { Words } from './Words';
import './teammate.css';

const api = window.mateApi;
/** Each teammate window loads this page with its view in the hash. */
const VIEW: MateView = (['bubble', 'card', 'words', 'history', 'consent', 'form'] as const).find((v) => location.hash === `#${v}`) ?? 'bubble';
const act = (a: MateAction): void => api.act(a);

function useDarkMode(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const onChange = (): void => setDark(m.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
  return dark;
}

/** Reports the content's size, so the transparent window around the bubble or card covers no more than it draws. */
function Sized({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sent = { width: 0, height: 0 };
    let settle: ReturnType<typeof setTimeout> | undefined;
    const send = (width: number, height: number): void => {
      if (width === sent.width && height === sent.height) return;
      sent = { width, height };
      api.size(sent);
    };
    // offsetWidth/Height ignore the scale animations, so a growing card doesn't resize its window mid-animation.
    const measure = (): { width: number; height: number; eased: boolean } => {
      // A card that eases its height says where it ends; the window follows that, not each frame of the ease.
      const card = el.querySelector<HTMLElement>(`[${HEIGHT_TARGET}]`);
      const ahead = card ? Number(card.getAttribute(HEIGHT_TARGET)) - card.offsetHeight : 0;
      return { width: el.offsetWidth, height: el.offsetHeight + (Number.isFinite(ahead) ? ahead : 0), eased: !!card };
    };
    // The height the pending shrink will settle at; a different one is a new shrink and waits out its own ease.
    let settling = 0;
    const report = (): void => {
      const { width, height, eased } = measure();
      const step = heightStep(sent.height, height, !eased || reducedMotion());
      send(width, step.window);
      if (step.settleMs === 0) {
        clearTimeout(settle);
        settle = undefined;
      } else if (settle === undefined || settling !== height) {
        clearTimeout(settle);
        settling = height;
        settle = setTimeout(() => {
          settle = undefined;
          const now = measure();
          send(now.width, now.height);
        }, step.settleMs);
      }
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    // The card's target moves before its box does, so the window grows ahead of the ease.
    const target = new MutationObserver(report);
    target.observe(el, { subtree: true, attributes: true, attributeFilter: [HEIGHT_TARGET] });
    report();
    return () => {
      clearTimeout(settle);
      observer.disconnect();
      target.disconnect();
    };
  }, []);
  return <div ref={ref} style={{ width: 'max-content' }}>{children}</div>;
}

function Root() {
  const dark = useDarkMode();
  const [state, setState] = useState<MateState | null>(null);
  const [leaving, setLeaving] = useState<MateLeave | null>(null);
  // Bumped when the window comes back after hiding, so the content mounts afresh and plays its arrival again.
  const [round, setRound] = useState(0);
  const left = useRef(false);
  const serial = useRef<number | undefined>(undefined);

  useEffect(
    () =>
      api.on((s) => {
        if (s.view !== VIEW) return;
        // A consent card or form preview shown again without hiding first is a new one: it mounts afresh too.
        const sided = s.view === 'consent' || s.view === 'form';
        const fresh = sided && serial.current !== undefined && s.serial !== serial.current;
        if (sided) serial.current = s.serial;
        if (fresh && !left.current) setRound((r) => r + 1);
        if (left.current) {
          left.current = false;
          setLeaving(null);
          setRound((r) => r + 1);
        }
        setState(s);
      }),
    [],
  );
  useEffect(
    () =>
      api.onLeave((how) => {
        left.current = true;
        setLeaving(how);
      }),
    [],
  );

  const lang = state?.lang ?? 'en';
  const t = strings(lang, api.platform);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.view = VIEW;
    if (VIEW === 'history') document.title = t.teammate.ui.historyTitle;
  }, [lang, t]);

  if (!state) return null;
  const ui = t.teammate.ui;
  let view: ReactNode;
  switch (state.view) {
    case 'bubble':
      view = <Sized><Bubble s={state} t={ui} act={act} leaving={leaving} /></Sized>;
      break;
    case 'card':
      view = <Sized><Card s={state} t={ui} act={act} leaving={leaving} /></Sized>;
      break;
    case 'consent':
      view = <Sized><Consent s={state} t={ui} act={act} leaving={leaving} /></Sized>;
      break;
    case 'form':
      view = <Sized><FormPreview s={state} t={ui} act={act} leaving={leaving} /></Sized>;
      break;
    case 'words':
      view = <Words s={state} t={ui} act={act} />;
      break;
    case 'history':
      view = <History s={state} t={t} act={act} />;
      break;
  }
  return (
    <FluentProvider
      key={round}
      theme={dark ? webDarkTheme : webLightTheme}
      style={{ background: 'transparent', height: VIEW === 'history' ? '100%' : undefined }}
    >
      {view}
    </FluentProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Root />);
