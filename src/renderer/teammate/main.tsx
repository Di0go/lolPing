import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { strings } from '../../shared/i18n';
import type { MateAction, MateLeave, MateState, MateView } from '../../shared/teammateIpc';
import { Bubble } from './Bubble';
import { Card } from './Card';
import { History } from './History';
import { Words } from './Words';
import './teammate.css';

const api = window.mateApi;
/** Each teammate window loads this page with its view in the hash. */
const VIEW: MateView = (['bubble', 'card', 'words', 'history'] as const).find((v) => location.hash === `#${v}`) ?? 'bubble';
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
    // offsetWidth/Height ignore the scale animations, so a growing card doesn't resize its window mid-animation.
    const report = (): void => api.size({ width: el.offsetWidth, height: el.offsetHeight });
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
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

  useEffect(
    () =>
      api.on((s) => {
        if (s.view !== VIEW) return;
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
  const t = strings(lang);
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
