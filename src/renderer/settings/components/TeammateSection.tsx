import { Button, Combobox, Dropdown, Input, Option, OptionGroup, Switch, Textarea } from '@fluentui/react-components';
import {
  Bot24Regular, ClipboardPaste24Regular, Color24Regular, CursorClick24Regular, DataUsage24Regular, DocumentText24Regular, Emoji24Regular,
  Eye24Regular, Globe24Regular, History24Regular, Keyboard24Regular, MusicNote224Regular, Person24Regular,
  ScanText24Regular, ShieldKeyhole24Regular, Sparkle24Regular, TextEditStyle24Regular, TextField24Regular,
} from '@fluentui/react-icons';
import { useEffect, useState, type ReactNode } from 'react';
import { ALL_PINGS, textureUrl, type PingId } from '../../../shared/pings';
import { TAG_COLORS } from '../../../shared/roomColors';
import { sameTrigger, triggerLabel, type Settings, type TriggerKey } from '../../../shared/settings';
import { parsePermissionKey } from '../../../shared/teammate/doRules';
import { needsKey, PROVIDERS, visionGuess, type ProviderId } from '../../../shared/teammate/providers';
import {
  INTENT_INSTRUCTION_MAX, INTENT_LABEL_MAX, TAG_NAME_MAX, type BuiltinProfile, type IntentOverride,
  type TeammateSettings,
} from '../../../shared/teammate/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow, SwitchRow } from './rows';
import { TriggerPicker } from './TriggerPicker';

/** Mirrors INSTRUCTIONS_MAX_CHARS in the main process's secret store. */
const INSTRUCTIONS_MAX = 2000;
/** History retention choices in days; null keeps threads until the thread cap. */
const KEEP_DAYS: readonly (number | null)[] = [7, 30, 90, 365, null];
const KEY_MAX = 4096;
/** Turning "same as the ping key" off picks the first of these that no other lolPing key uses. */
const ASK_KEYS: readonly TriggerKey[] = ['win', 'alt', 'ctrl', 'shift', 'mouse5', 'mouse4'];

type Patch = (p: Partial<TeammateSettings>) => void;

/** Short and unique enough for a handful of profiles; the same shape the settings file accepts. */
const newProfileId = (): string => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function Swatches({ label, color, onPick }: { label: string; color: number; onPick(i: number): void }) {
  const t = useText();
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {TAG_COLORS.map((c, i) => (
        <button key={c} type="button" role="radio" aria-checked={color === i} aria-label={t.roomColorLabel(i + 1)}
          className={`swatch${color === i ? ' sel' : ''}`} style={{ background: c }} onClick={() => onPick(i)} />
      ))}
    </div>
  );
}

/** A text field that saves when it loses focus or on Enter, so each keystroke isn't a settings write. */
function DraftInput({ value, onSave, maxLength, placeholder, width }: {
  value: string; onSave(v: string): void; maxLength?: number; placeholder?: string; width?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    if (draft !== value) onSave(draft);
  };
  return (
    <Input value={draft} maxLength={maxLength} placeholder={placeholder} style={{ width: width ?? 260 }}
      onChange={(_, d) => setDraft(d.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
  );
}

function ProfileCard({ p, onChange, onRemove }: {
  p: BuiltinProfile; onChange(patch: Partial<BuiltinProfile>): void; onRemove(): void;
}) {
  const t = useText();
  const m = t.teammate.settings;
  const provider = PROVIDERS.find((x) => x.id === p.provider);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(p.model);
  useEffect(() => setModel(p.model), [p.model]);
  useEffect(() => {
    void api.hasTeammateKey(p.id).then(setHasKey);
  }, [p.id]);

  const saveKey = async (value: string) => {
    const r = await api.setTeammateKey(p.id, value);
    setKeyError(r.ok ? null : m.keyUnavailable);
    if (r.ok) setKey('');
    setHasKey(await api.hasTeammateKey(p.id));
  };
  const checkKey = async () => {
    setChecking(true);
    const r = await api.checkTeammateKey(p.id);
    setChecking(false);
    if (r.ok) {
      setModels(r.models);
      setCheck({ ok: true, text: m.checkOk(r.models.length) });
    } else {
      const line = r.error === 'auth' ? m.checkAuth : r.error === 'network' ? m.checkNetwork : m.checkOther;
      setCheck({ ok: false, text: r.message && r.message !== line ? `${line} ${r.message}` : line });
    }
  };
  const keyless = !needsKey(p);

  return (
    <div className="card mate">
      <div className="mateHead">
        <b>{p.name || provider?.name}</b>
        <span className="desc inline">{provider?.name}</span>
        <Button size="small" appearance="subtle" onClick={onRemove}>{m.removeProfile}</Button>
      </div>
      <div className="mateFields">
        <span>{m.profileName}</span>
        <DraftInput value={p.name} maxLength={60} onSave={(name) => onChange({ name })} />
        <span>{m.baseUrl}</span>
        <DraftInput value={p.baseUrl} maxLength={2048} width={360}
          onSave={(baseUrl) => onChange({ baseUrl: baseUrl.trim() })} />
        <span>{m.key}</span>
        <div className="mateRow">
          <Input type="password" autoComplete="off" value={key} maxLength={KEY_MAX} style={{ width: 260 }}
            placeholder={hasKey ? m.keySavedPlaceholder : keyless ? m.keyNotNeeded : m.keyPlaceholder}
            onChange={(_, d) => setKey(d.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey(key)} />
          <Button disabled={!key.trim()} onClick={() => void saveKey(key)}>{m.saveKey}</Button>
          {hasKey ? <Button appearance="subtle" onClick={() => void saveKey('')}>{m.removeKey}</Button> : null}
        </div>
        {keyError ? <><span /><span className="weImportError">{keyError}</span></> : null}
        <span />
        <div className="mateRow">
          <Button disabled={(!hasKey && !keyless) || checking} onClick={() => void checkKey()}>
            {checking ? m.checking : m.checkKey}
          </Button>
          <span className={check && !check.ok ? 'weImportError' : 'desc'}>{check ? check.text : m.checkKeyDesc}</span>
        </div>
        <span>{m.model}</span>
        <Combobox freeform value={model} placeholder={m.modelPlaceholder} style={{ width: 260 }}
          selectedOptions={p.model ? [p.model] : []}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model.trim() !== p.model && onChange({ model: model.trim() })}
          onOptionSelect={(_, d) => {
            if (!d.optionValue) return;
            setModel(d.optionValue);
            onChange({ model: d.optionValue });
          }}>
          {models.map((id) => <Option key={id} value={id}>{id}</Option>)}
        </Combobox>
        {visionGuess(p.model) === false ? <><span /><span className="weImportError">{m.modelNoVision}</span></> : null}
      </div>
    </div>
  );
}

/** One context source inside the "What the teammate reads" card: a SwitchRow without its own card. */
function ReadRow({ icon, title, description, checked, onChange }: {
  icon: ReactNode; title: string; description: string; checked: boolean; onChange(v: boolean): void;
}) {
  const t = useText();
  return (
    <div className="mateRead">
      <span className="icon">{icon}</span>
      <div className="lbl">
        {title}
        <span className="desc">{description}</span>
      </div>
      <Switch checked={checked} aria-label={title} onChange={(_, d) => onChange(d.checked)}
        label={checked ? t.on : t.off} labelPosition="before" />
    </div>
  );
}

function IntentRow({ id, override, patch }: {
  id: PingId; override: IntentOverride | undefined; patch(o: IntentOverride | null): void;
}) {
  const t = useText();
  const m = t.teammate.settings;
  const def = t.teammate.intent[id];
  const icon = ALL_PINGS.find((p) => p.id === id)?.icon;
  const [label, setLabel] = useState(override?.label ?? '');
  const [instruction, setInstruction] = useState(override?.instruction ?? '');
  useEffect(() => setLabel(override?.label ?? ''), [override?.label]);
  useEffect(() => setInstruction(override?.instruction ?? ''), [override?.instruction]);
  /** Empty fields fall back to the default, so they are left out of the override. */
  const save = (next: IntentOverride) => {
    const o: IntentOverride = {};
    const merged = { ...override, ...next };
    if (merged.enabled === false) o.enabled = false;
    if (merged.label) o.label = merged.label;
    if (merged.instruction) o.instruction = merged.instruction;
    patch(Object.keys(o).length > 0 ? o : null);
  };
  return (
    <div className="mateIntent">
      <span className="mateIntentName">
        {icon ? <img src={textureUrl(icon)} alt="" /> : null}
        {t.pingNames[id]}
      </span>
      <Switch checked={override?.enabled ?? true} aria-label={t.pingNames[id]}
        onChange={(_, d) => save({ enabled: d.checked })} />
      <Input value={label} maxLength={INTENT_LABEL_MAX} placeholder={def.label} aria-label={m.intentLabel}
        onChange={(_, d) => setLabel(d.value)}
        onBlur={() => label.trim() !== (override?.label ?? '') && save({ label: label.trim() })} />
      <Textarea value={instruction} maxLength={INTENT_INSTRUCTION_MAX} placeholder={def.instruction} resize="vertical"
        aria-label={m.intentInstruction} onChange={(_, d) => setInstruction(d.value)}
        onBlur={() => instruction !== (override?.instruction ?? '') && save({ instruction })} />
      <Button size="small" appearance="subtle" disabled={!override} onClick={() => patch(null)}>{m.intentReset}</Button>
    </div>
  );
}

function InstructionsCard() {
  const t = useText();
  const m = t.teammate.settings;
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.getTeammateInstructions().then((text) => {
      setSaved(text);
      setDraft(text);
    });
  }, []);
  const save = async () => {
    const r = await api.setTeammateInstructions(draft);
    setError(r.ok ? null : m.instructionsUnavailable);
    if (r.ok) setSaved(draft);
  };
  return (
    <div className="card mate">
      <div className="mateHead">
        <span className="icon"><TextEditStyle24Regular /></span>
        <div className="lbl">
          {m.instructions}
          <span className="desc">{m.instructionsDesc}</span>
        </div>
      </div>
      <Textarea className="mateInstructions" value={draft} maxLength={INSTRUCTIONS_MAX} placeholder={m.instructionsPlaceholder}
        resize="vertical" aria-label={m.instructions} onChange={(_, d) => setDraft(d.value)} />
      <div className="mateRow">
        <Button disabled={draft === saved} onClick={() => void save()}>
          {draft === saved && saved ? m.instructionsSaved : m.instructionsSave}
        </Button>
        <span className="desc">{m.instructionsCount(draft.length, INSTRUCTIONS_MAX)}</span>
        {error ? <span className="weImportError">{error}</span> : null}
      </div>
    </div>
  );
}

/** What Always allow saved: each line can be taken back. Keys of a removed profile are already gone from the file. */
function PermissionsCard({ s, patch }: { s: TeammateSettings; patch: Patch }) {
  const t = useText();
  const m = t.teammate.settings;
  const rows = s.permissions.flatMap((key) => {
    const k = parsePermissionKey(key);
    const profile = k && s.profiles.find((p) => p.id === k.profileId);
    return k && profile ? [{ key, text: m.permissionLine(profile.name, m.permissionActions[k.action]) }] : [];
  });
  return (
    <div className="card mate">
      <div className="mateHead">
        <span className="icon"><ShieldKeyhole24Regular /></span>
        <div className="lbl">
          {m.permissions}
          {rows.length === 0 ? <span className="desc">{m.permissionsEmpty}</span> : null}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="mateRead">
          <div className="lbl">{r.text}</div>
          <Button size="small" appearance="subtle" aria-label={`${m.permissionRemove}: ${r.text}`}
            onClick={() => patch({ permissions: s.permissions.filter((p) => p !== r.key) })}>
            {m.permissionRemove}
          </Button>
        </div>
      ))}
    </div>
  );
}

function UsageRow() {
  const t = useText();
  const m = t.teammate.settings;
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  useEffect(() => {
    const load = () => void api.getTeammateUsage().then(setUsage);
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const n = (v: number) => v.toLocaleString(t.lang);
  return (
    <SettingRow icon={<DataUsage24Regular />} title={m.usage} description={m.usageDesc}>
      <span className="value">{usage ? m.usageValue(n(usage.input), n(usage.output)) : ''}</span>
    </SettingRow>
  );
}

function HistoryRows({ s, patch, secrets }: { s: TeammateSettings; patch: Patch; secrets: boolean }) {
  const t = useText();
  const m = t.teammate.settings;
  const [confirm, setConfirm] = useState(false);
  const [cleared, setCleared] = useState<boolean | null>(null);
  const h = s.history;
  const description = !secrets ? m.secretsUnavailable : h.paused ? m.historyPaused : m.historyDesc;
  const keepLabel = (d: number | null) => (d === null ? m.keepForever : m.keepDays(d));
  return (
    <>
      <SwitchRow icon={<History24Regular />} title={m.history} description={description} dim={!secrets}
        disabled={!secrets} checked={h.on && secrets} onChange={(on) => patch({ history: { ...h, on } })} />
      <SettingRow icon={<History24Regular />} title={m.keepFor} dim={!h.on || !secrets}>
        <Dropdown style={{ minWidth: 170 }} value={keepLabel(h.keepDays)} selectedOptions={[String(h.keepDays)]}
          onOptionSelect={(_, d) => {
            const days = KEEP_DAYS.find((k) => String(k) === d.optionValue);
            if (days !== undefined) patch({ history: { ...h, keepDays: days } });
          }}>
          {KEEP_DAYS.map((d) => <Option key={String(d)} value={String(d)} text={keepLabel(d)}>{keepLabel(d)}</Option>)}
        </Dropdown>
        <Button onClick={() => void api.teammateHistory(h.paused ? 'resume' : 'pause')}>
          {h.paused ? m.resumeHistory : m.pauseHistory}
        </Button>
        {confirm ? (
          <Button appearance="primary" onClick={() => {
            setConfirm(false);
            void api.teammateHistory('clear').then(setCleared);
          }}>{m.clearHistoryConfirm}</Button>
        ) : <Button onClick={() => {
          setCleared(null);
          setConfirm(true);
        }}>{m.clearHistory}</Button>}
        <Button onClick={() => void api.teammateHistory('open')}>{m.openHistory}</Button>
      </SettingRow>
      {cleared === null ? null : (
        <div className={cleared ? 'rowNote' : 'rowError'} role="status">
          {cleared ? m.historyCleared : m.historyClearFailed}
        </div>
      )}
    </>
  );
}

/** macOS only: shown while Screen Recording is off. Same shape as the Accessibility card. */
function ScreenAccessCard() {
  const t = useText();
  const m = t.teammate.settings;
  return (
    <div className="card permission">
      <span className="icon"><ShieldKeyhole24Regular /></span>
      <div className="lbl">
        <b>{m.screenTitle}</b>
        <span className="desc">{m.screenWhy}</span>
        <ol className="desc">
          {m.screenSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <div className="actions">
          <Button appearance="primary" onClick={() => void api.openScreenRecording()}>{m.screenOpen}</Button>
        </div>
      </div>
    </div>
  );
}

/** Settings → Teammate: profiles and keys, the ask key, intents, Your instructions, history and usage. */
export function TeammateSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const m = t.teammate.settings;
  const mate = s.teammate;
  const patch: Patch = (p) => void update({ teammate: { ...mate, ...p } });
  const same = mate.askTrigger === 'same';
  const askLabel = triggerLabel(mate.askTrigger === 'same' ? s.trigger : mate.askTrigger, t.lang, api.platform);
  const ownAskKey = ASK_KEYS.find((k) => !sameTrigger(k, s.trigger) && !sameTrigger(k, s.emoteTrigger)) ?? 'win';
  const profileName = (id: string | null) => mate.profiles.find((p) => p.id === id)?.name ?? m.noProfile;
  const [secrets, setSecrets] = useState(true);
  const [screenAccess, setScreenAccess] = useState<boolean | null>(null);
  useEffect(() => {
    // Read again when the window regains focus: the user comes back from System Settings.
    const load = () => void api.getTeammateStatus().then((st) => {
      setSecrets(st.secretsAvailable);
      setScreenAccess(st.screenAccess);
    });
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const addProfile = (id: ProviderId) => {
    const preset = PROVIDERS.find((p) => p.id === id);
    if (!preset) return;
    const profile: BuiltinProfile = {
      id: newProfileId(), kind: 'builtin', name: preset.name, tagColor: mate.tagColor, tagColorCustom: null,
      provider: preset.id, protocol: preset.protocol, baseUrl: preset.baseUrl, model: '',
    };
    patch({ profiles: [...mate.profiles, profile], defaultProfile: mate.defaultProfile ?? profile.id });
  };
  const changeProfile = (id: string, p: Partial<BuiltinProfile>) =>
    patch({ profiles: mate.profiles.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const removeProfile = (id: string) => {
    void api.setTeammateKey(id, ''); // its key goes with it
    const profiles = mate.profiles.filter((x) => x.id !== id);
    patch({
      profiles,
      defaultProfile: mate.defaultProfile === id ? profiles[0]?.id ?? null : mate.defaultProfile,
      deepProfile: mate.deepProfile === id ? null : mate.deepProfile,
    });
  };
  const patchIntent = (id: PingId, o: IntentOverride | null) => {
    const intents = { ...mate.intents };
    if (o) intents[id] = o;
    else delete intents[id];
    patch({ intents });
  };

  return (
    <>
      {screenAccess === false ? <ScreenAccessCard /> : null}
      <div className="card mate">
        <div className="mateHead">
          <span className="icon"><Bot24Regular /></span>
          <div className="lbl">
            {m.profiles}
            <span className="desc">{mate.profiles.length > 0 ? m.profilesDesc : `${m.profilesDesc} ${m.noProfiles}`}</span>
          </div>
          <Dropdown style={{ minWidth: 190 }} placeholder={m.addProfile} value="" selectedOptions={[]}
            onOptionSelect={(_, d) => {
              const preset = PROVIDERS.find((p) => p.id === d.optionValue);
              if (preset) addProfile(preset.id);
            }}>
            <OptionGroup label={m.providerCloud}>
              {PROVIDERS.filter((p) => p.group === 'cloud').map((p) => (
                <Option key={p.id} value={p.id}>{p.name}</Option>
              ))}
            </OptionGroup>
            <OptionGroup label={m.providerLocal}>
              {PROVIDERS.filter((p) => p.group === 'local').map((p) => (
                <Option key={p.id} value={p.id}>{p.name}</Option>
              ))}
            </OptionGroup>
          </Dropdown>
        </div>
      </div>
      {mate.profiles.map((p) => (
        <ProfileCard key={p.id} p={p} onChange={(x) => changeProfile(p.id, x)} onRemove={() => removeProfile(p.id)} />
      ))}
      {mate.profiles.length > 0 ? (
        <>
          <SettingRow icon={<Bot24Regular />} title={m.defaultProfile} description={m.defaultProfileDesc}>
            <Dropdown style={{ minWidth: 190 }} value={profileName(mate.defaultProfile)}
              selectedOptions={mate.defaultProfile ? [mate.defaultProfile] : []}
              onOptionSelect={(_, d) => d.optionValue && patch({ defaultProfile: d.optionValue })}>
              {mate.profiles.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
            </Dropdown>
          </SettingRow>
          <SettingRow icon={<Sparkle24Regular />} title={m.deepProfile} description={m.deepProfileDesc}>
            <Dropdown style={{ minWidth: 190 }} value={mate.deepProfile ? profileName(mate.deepProfile) : m.useDefault}
              selectedOptions={[mate.deepProfile ?? '']}
              onOptionSelect={(_, d) => patch({ deepProfile: d.optionValue ? d.optionValue : null })}>
              <Option value="" text={m.useDefault}>{m.useDefault}</Option>
              {mate.profiles.map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
            </Dropdown>
          </SettingRow>
        </>
      ) : null}

      <SwitchRow icon={<Keyboard24Regular />} title={m.askKeySame}
        description={same ? m.askKeySameNote : undefined}
        checked={same} onChange={(on) => patch({ askTrigger: on ? 'same' : ownAskKey })} />
      {same ? null : (
        <SettingRow icon={<Keyboard24Regular />} title={m.askKey} description={m.askKeyDesc}>
          <TriggerPicker value={mate.askTrigger === 'same' ? s.trigger : mate.askTrigger}
            blocked={[s.emoteTrigger, s.trigger]}
            onChange={(k) => {
              if (k !== 'off') patch({ askTrigger: k });
            }} />
        </SettingRow>
      )}
      <SwitchRow icon={<CursorClick24Regular />} title={m.askClick(askLabel)} description={m.askClickDesc}
        checked={mate.askClick} onChange={(askClick) => patch({ askClick })} />
      <SettingRow icon={<Person24Regular />} title={m.tagName} description={m.tagNameDesc}>
        <DraftInput value={mate.tagName} maxLength={TAG_NAME_MAX} width={140} onSave={(tagName) => patch({ tagName })} />
      </SettingRow>
      <SettingRow icon={<Color24Regular />} title={m.tagColor}>
        <Swatches label={m.tagColor} color={mate.tagColorCustom ? -1 : mate.tagColor}
          onPick={(i) => patch({ tagColor: i, tagColorCustom: null })} />
      </SettingRow>

      <div className="card mate">
        <div className="mateHead">
          <span className="icon"><Eye24Regular /></span>
          <div className="lbl">{m.reads}</div>
        </div>
        <ReadRow icon={<ScanText24Regular />} title={m.readMarks} description={m.readMarksDesc}
          checked={mate.context.marks} onChange={(marks) => patch({ context: { ...mate.context, marks } })} />
        <ReadRow icon={<TextField24Regular />} title={m.readSystemText} description={m.readSystemTextDesc}
          checked={mate.context.systemText}
          onChange={(systemText) => patch({ context: { ...mate.context, systemText } })} />
        <ReadRow icon={<DocumentText24Regular />} title={m.readFiles} description={m.readFilesDesc}
          checked={mate.context.files} onChange={(files) => patch({ context: { ...mate.context, files } })} />
        <ReadRow icon={<Globe24Regular />} title={m.readWebPdfs} description={m.readWebPdfsDesc}
          checked={mate.context.webPdfs} onChange={(webPdfs) => patch({ context: { ...mate.context, webPdfs } })} />
        <ReadRow icon={<ClipboardPaste24Regular />} title={m.readFormPaste} description={m.readFormPasteDesc}
          checked={mate.context.clipboardForForms}
          onChange={(clipboardForForms) => patch({ context: { ...mate.context, clipboardForForms } })} />
      </div>

      <div className="card mate">
        <div className="mateHead">
          <span className="icon"><Sparkle24Regular /></span>
          <div className="lbl">
            {m.intents}
            <span className="desc">{m.intentsDesc}</span>
          </div>
        </div>
        {ALL_PINGS.map((p) => (
          <IntentRow key={p.id} id={p.id} override={mate.intents[p.id]} patch={(o) => patchIntent(p.id, o)} />
        ))}
      </div>
      <InstructionsCard />
      <PermissionsCard s={mate} patch={patch} />

      <SwitchRow icon={<Emoji24Regular />} title={m.emotes} description={m.emotesDesc}
        checked={mate.emotes} onChange={(emotes) => patch({ emotes })} />
      <SwitchRow icon={<MusicNote224Regular />} title={m.receiptSound} description={m.receiptSoundDesc}
        checked={mate.receiptSound} onChange={(receiptSound) => patch({ receiptSound })} />
      <HistoryRows s={mate} patch={patch} secrets={secrets} />
      <UsageRow />
      <p className="desc roomNote">{m.privacy}</p>
    </>
  );
}
