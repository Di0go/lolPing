import { Button, Combobox, Dropdown, Option } from '@fluentui/react-components';
import { AppsListDetail24Regular, ArrowDown16Regular, ArrowUp16Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { ALL_PINGS, isPingId } from '../../../shared/pings';
import { addRule, editorRules, moveRule } from '../../../shared/teammate/appRules';
import type { AppRule, TeammateSettings } from '../../../shared/teammate/settings';
import { api } from '../api';
import { useText } from '../text';
import { DraftInput } from './mateFields';
import { ExpanderRow } from './rows';

/** App names without repeats (ignoring case), the first spelling kept. */
function uniqueApps(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  return lists.flat().filter((a) => {
    const key = a.toLowerCase();
    if (a === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The app name of a rule: free text, with the apps seen in asks and the installed editors as suggestions. */
function AppField({ value, suggestions, onSave }: {
  value: string; suggestions: readonly string[]; onSave(v: string): void;
}) {
  const t = useText();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // A rule without an app isn't kept by settings, so an empty field goes back to the saved name.
  const commit = (v: string) => {
    const next = v.trim();
    if (next === '') setDraft(value);
    else if (next !== value) onSave(next);
  };
  return (
    <Combobox freeform value={draft} placeholder={t.teammate.settings.ruleAppPlaceholder} style={{ width: 260 }}
      aria-label={t.teammate.settings.ruleApp} selectedOptions={[value]} maxLength={200}
      onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(draft)}
      onOptionSelect={(_, d) => {
        if (!d.optionValue) return;
        setDraft(d.optionValue);
        commit(d.optionValue);
      }}>
      {suggestions.map((a) => <Option key={a} value={a}>{a}</Option>)}
    </Combobox>
  );
}

function RuleRow({ rule, index, count, profiles, suggestions, change, move, remove }: {
  rule: AppRule; index: number; count: number; profiles: TeammateSettings['profiles']; suggestions: readonly string[];
  change(patch: Partial<AppRule>): void; move(by: -1 | 1): void; remove(): void;
}) {
  const t = useText();
  const m = t.teammate.settings;
  const profile = profiles.find((p) => p.id === rule.profile);
  const pings = rule.intents.length === 0
    ? m.ruleAllPings
    : rule.intents.map((id) => t.pingNames[id]).join(t.teammate.ui.listSep);
  return (
    <div className="mateRule">
      <div className="mateHead">
        <b>{rule.app}</b>
        <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} disabled={index === 0}
          aria-label={m.ruleUp(rule.app)} title={m.ruleUp(rule.app)} onClick={() => move(-1)} />
        <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} disabled={index === count - 1}
          aria-label={m.ruleDown(rule.app)} title={m.ruleDown(rule.app)} onClick={() => move(1)} />
        <Button size="small" appearance="subtle" aria-label={m.ruleRemoveLabel(rule.app)} onClick={remove}>
          {m.ruleRemove}
        </Button>
      </div>
      <div className="mateFields">
        <span>{m.ruleApp}</span>
        <AppField value={rule.app} suggestions={suggestions} onSave={(app) => change({ app })} />
        <span>{m.ruleTitle}</span>
        <DraftInput value={rule.titleContains} maxLength={200} placeholder={m.ruleTitlePlaceholder}
          onSave={(titleContains) => change({ titleContains: titleContains.trim() })} />
        <span>{m.rulePings}</span>
        <Dropdown multiselect style={{ minWidth: 260 }} value={pings} selectedOptions={rule.intents}
          aria-label={m.rulePings}
          onOptionSelect={(_, d) => change({ intents: d.selectedOptions.filter(isPingId) })}>
          {ALL_PINGS.map((p) => <Option key={p.id} value={p.id} text={t.pingNames[p.id]}>{t.pingNames[p.id]}</Option>)}
        </Dropdown>
        <span>{m.ruleProfile}</span>
        <Dropdown style={{ minWidth: 260 }} value={profile?.name ?? m.noProfile} selectedOptions={[rule.profile]}
          aria-label={m.ruleProfile} onOptionSelect={(_, d) => d.optionValue && change({ profile: d.optionValue })}>
          {profiles.map((p) => <Option key={p.id} value={p.id} text={p.name}>{p.name}</Option>)}
        </Dropdown>
      </div>
    </div>
  );
}

/** Which profile answers an ask from which app, first match wins; and a shortcut for the editors on this computer. */
export function RulesCard({ s, patch }: { s: TeammateSettings; patch(p: Partial<TeammateSettings>): void }) {
  const t = useText();
  const m = t.teammate.settings;
  const [recent, setRecent] = useState<string[]>([]);
  const [editors, setEditors] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void api.getTeammateRecentApps().then(setRecent);
    load();
    void api.getTeammateEditors().then(setEditors);
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const suggestions = uniqueApps(recent, editors);
  const agent = s.profiles.find((p) => p.kind === 'agent')?.id ?? null;
  const fallback = s.defaultProfile ?? s.profiles[0]?.id ?? null;
  const setRules = (rules: AppRule[]) => {
    setNote(null);
    patch({ rules });
  };

  const suggest = async () => {
    // Read again: the editors may have been installed since this page opened.
    const found = await api.getTeammateEditors();
    setEditors(found);
    const r = editorRules(found, s.rules, agent);
    if (r.kind === 'added') {
      patch({ rules: r.rules });
      setNote(m.ruleSuggestAdded(r.added));
    } else {
      setNote(r.kind === 'noAgent' ? m.ruleSuggestNoAgent
        : r.kind === 'noEditors' ? m.ruleSuggestNoEditors : m.ruleSuggestExists);
    }
  };

  return (
    <ExpanderRow icon={<AppsListDetail24Regular />} title={m.rules}
      description={s.rules.length === 0 ? `${m.rulesDesc} ${m.rulesEmpty}` : m.rulesDesc}>
      <div className="expPane">
        {s.rules.map((r, i) => (
          <RuleRow key={i} rule={r} index={i} count={s.rules.length} profiles={s.profiles} suggestions={suggestions}
            change={(p) => setRules(s.rules.map((x, j) => (j === i ? { ...x, ...p } : x)))}
            move={(by) => setRules(moveRule(s.rules, i, by))}
            remove={() => setRules(s.rules.filter((_, j) => j !== i))} />
        ))}
        <div className="mateRule">
          <div className="mateRow">
            <Combobox freeform value={draft} placeholder={m.ruleAppPlaceholder} style={{ width: 260 }}
              aria-label={m.ruleApp} selectedOptions={[]} maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onOptionSelect={(_, d) => d.optionValue && setDraft(d.optionValue)}>
              {suggestions.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Combobox>
            <Button disabled={draft.trim() === '' || fallback === null} onClick={() => {
              if (fallback === null) return;
              setRules(addRule(s.rules, draft, fallback));
              setDraft('');
            }}>{m.ruleAdd}</Button>
            <Button onClick={() => void suggest()}>{m.ruleSuggest}</Button>
          </div>
          {note ? <span className="desc" role="status">{note}</span> : null}
        </div>
      </div>
    </ExpanderRow>
  );
}
