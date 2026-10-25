import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
} from '@fluentui/react-components';
import {
  Bot24Regular, Checkmark24Regular, CursorClick24Regular, Dismiss24Regular, History24Regular, Keyboard24Regular,
} from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { triggerLabel, type Settings } from '../../../shared/settings';
import { editorRules } from '../../../shared/teammate/appRules';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { firstRunSteps, TeammateChanges, wordsHow, type FirstRunStep } from '../firstRun';
import { AddProfileMenu, AskKeyRows, ProfileCards, ScreenAccessCard, type Patch } from './TeammateSection';

/**
 * A short walk through the ask key, a profile, Screen Recording on a Mac, and how to ask. It was marked done when it
 * opened (FeaturesSection), so any way out just closes it.
 */
export function FirstRunDialog({ settings: s, update, onClose }: { settings: Settings; update: Update; onClose(): void }) {
  const t = useText();
  const f = t.teammate.firstRun;
  const m = t.teammate.settings;
  const mate = s.teammate;
  const [changes] = useState(() => new TeammateChanges(mate, (next) => update({ teammate: next })));
  useEffect(() => changes.seen(mate), [changes, mate]);
  const patch: Patch = (p) => void changes.change(p);
  const [step, setStep] = useState<FirstRunStep>('askKey');
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  // Once the screen step is in, it stays: granting access while on it must not drop the step from under the user.
  const [needScreen, setNeedScreen] = useState(false);
  const [editors, setEditors] = useState<string[]>([]);
  const [sendEditors, setSendEditors] = useState(true);
  /** Profiles added here start open. */
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    // Read again when the window regains focus: the user comes back from System Settings.
    const load = () => void api.getTeammateStatus().then((st) => {
      setScreenAccess(st.screenAccess);
      if (st.screenAccess === false) setNeedScreen(true);
    });
    load();
    void api.getTeammateEditors().then(setEditors);
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const steps = firstRunSteps(api.platform, needScreen ? false : screenAccess);
  const index = Math.max(0, steps.indexOf(step));
  const last = index === steps.length - 1;
  const agent = [...added].reverse().find((id) => mate.profiles.some((p) => p.id === id && p.kind === 'agent')) ?? null;
  const askKey = mate.askTrigger === 'same' ? s.trigger : mate.askTrigger;
  const askLabel = triggerLabel(askKey, t.lang, api.platform);
  const how = wordsHow(mate, askKey);

  const finish = onClose;
  const next = () => {
    if (step === 'profile' && agent !== null && sendEditors) {
      void changes.change((latest) => {
        const r = editorRules(editors, latest.rules, agent);
        return r.kind === 'added' ? { rules: r.rules } : null;
      });
    }
    const to = steps[index + 1];
    if (to) setStep(to);
    else finish();
  };
  const back = () => {
    const to = steps[index - 1];
    if (to) setStep(to);
  };

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && finish()}>
      <DialogSurface style={{ width: 'min(720px, calc(100vw - 32px))', maxWidth: 'none' }}>
        <DialogBody>
          <DialogTitle action={
            <Button appearance="subtle" aria-label={f.close} icon={<Dismiss24Regular />} onClick={finish} />
          }>{f.title}</DialogTitle>
          <DialogContent>
            <div className="firstRunStep">
              <b>{f.steps[step]}</b>
              <span className="desc">{f.stepOf(index + 1, steps.length)}</span>
            </div>
            {step === 'askKey' ? (
              <>
                <p className="desc firstRunIntro">{f.askKeyIntro}</p>
                <AskKeyRows s={s} patch={patch} words="platform" />
              </>
            ) : null}
            {step === 'profile' ? (
              <>
                <p className="desc firstRunIntro">{f.profileIntro}</p>
                <div className="card mate">
                  <div className="mateHead">
                    <span className="icon"><Bot24Regular /></span>
                    <div className="lbl">
                      {m.profiles}
                      {mate.profiles.length > 0 ? null : <span className="desc">{m.noProfiles}</span>}
                    </div>
                    <AddProfileMenu mate={mate} patch={patch}
                      onAdded={(id) => setAdded((ids) => [...ids, id])} />
                  </div>
                </div>
                <ProfileCards mate={mate} patch={patch} open={(id) => added.includes(id)} />
                {agent !== null && editors.length > 0 ? (
                  <Checkbox checked={sendEditors} onChange={(_, d) => setSendEditors(d.checked === true)}
                    label={f.editors(mate.profiles.find((p) => p.id === agent)?.name ?? '',
                      t.teammate.intent.omw.label, t.teammate.intent.danger.label)} />
                ) : null}
              </>
            ) : null}
            {step === 'screen' ? (
              screenAccess === false ? <ScreenAccessCard /> : (
                <div className="card">
                  <span className="icon"><Checkmark24Regular /></span>
                  <div className="lbl">{f.screenOn}</div>
                </div>
              )
            ) : null}
            {step === 'done' ? (
              <>
                <div className="card">
                  <span className="icon"><Keyboard24Regular /></span>
                  <div className="lbl">{f.ready(askLabel)}</div>
                </div>
                {how === null ? null : (
                  <div className="card">
                    <span className="icon"><CursorClick24Regular /></span>
                    <div className="lbl">{how === 'click' ? f.readyClick(askLabel) : f.readyDoubleTap(askLabel)}</div>
                  </div>
                )}
                <div className="card">
                  <span className="icon"><History24Regular /></span>
                  <div className="lbl">{f.readyKept}</div>
                </div>
              </>
            ) : null}
          </DialogContent>
          <DialogActions>
            {last ? null : <Button appearance="subtle" onClick={finish}>{f.skip}</Button>}
            {index > 0 ? <Button onClick={back}>{f.back}</Button> : null}
            <Button appearance="primary" onClick={next}>{last ? f.done : f.next}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
