import { Button, Radio, RadioGroup, SpinButton, Textarea } from '@fluentui/react-components';
import { Code24Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import type { CheckAgentResult } from '../../../shared/ipc';
import { agentNotes, timeoutMinutes, timeoutSeconds, withFolder } from '../../../shared/teammate/agentProfiles';
import { AGENT_PRESETS } from '../../../shared/teammate/agents';
import type { AgentProfile } from '../../../shared/teammate/settings';
import { api } from '../api';
import { useText } from '../text';
import { DraftInput, Swatches } from './mateFields';
import { ExpanderRow } from './rows';

/** One argument per line; empty lines at the end are the textarea's trailing line break, not arguments. */
function linesOf(text: string): string[] {
  const body = text.replace(/(\r?\n)+$/, '');
  return body === '' ? [] : body.split(/\r?\n/);
}

type FolderMode = AgentProfile['folder']['kind'];

function CheckResult({ r }: { r: CheckAgentResult }) {
  const t = useText();
  const m = t.teammate.settings;
  if (r.ok) return <span className="desc">{m.agentFound(r.version)}</span>;
  const text = r.reason === 'notFound' ? m.agentNotFound
    : r.reason === 'timeout' ? m.agentCheckTimeout : m.agentCheckFailed(r.detail);
  return <span className="weImportError">{text}</span>;
}

function FolderRows({ p, onChange }: { p: AgentProfile; onChange(patch: Partial<AgentProfile>): void }) {
  const t = useText();
  const m = t.teammate.settings;
  // A fixed folder with no path isn't a saved state, so choosing "Fixed folder" first only shows its Browse button.
  const [mode, setMode] = useState<FolderMode>(p.folder.kind);
  useEffect(() => setMode(p.folder.kind), [p.folder.kind]);
  const fixed = p.folder.kind === 'fixed' ? p.folder.path : '';
  const folders = p.folder.kind === 'editor' ? p.folder.folders : [];

  const browse = async (): Promise<string | null> => api.pickTeammateFolder();
  const pickFixed = async () => {
    const path = await browse();
    if (path !== null) onChange({ folder: { kind: 'fixed', path } });
  };
  const addFolder = async () => {
    const path = await browse();
    if (path !== null) onChange({ folder: { kind: 'editor', folders: withFolder(folders, path) } });
  };
  const choose = (next: FolderMode) => {
    setMode(next);
    if (next === 'editor' && p.folder.kind !== 'editor') onChange({ folder: { kind: 'editor', folders: [] } });
  };

  return (
    <>
      <span>{m.agentFolder}</span>
      <div className="mateStack">
        <RadioGroup layout="horizontal" value={mode} aria-label={m.agentFolder}
          onChange={(_, d) => choose(d.value === 'fixed' ? 'fixed' : 'editor')}>
          <Radio value="fixed" label={m.agentFolderFixed} />
          <Radio value="editor" label={m.agentFolderEditor} />
        </RadioGroup>
        {mode === 'fixed' ? (
          <div className="mateRow">
            <span className={fixed ? 'matePath' : 'desc'}>{fixed || m.agentFolderNone}</span>
            <Button onClick={() => void pickFixed()}>{m.browse}</Button>
          </div>
        ) : (
          <>
            <span className="desc">{m.agentFolderEditorDesc}</span>
            {folders.length === 0 ? <span className="desc">{m.agentFoldersEmpty}</span> : null}
            {folders.map((f) => (
              <div key={f} className="mateRow">
                <span className="matePath">{f}</span>
                <Button size="small" appearance="subtle" aria-label={m.removeFolderLabel(f)}
                  onClick={() => onChange({ folder: { kind: 'editor', folders: folders.filter((x) => x !== f) } })}>
                  {m.removeFolder}
                </Button>
              </div>
            ))}
            <div className="mateRow">
              <Button onClick={() => void addFolder()}>{m.addFolder}</Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** The notes under the card: what the agent does about approvals, whether it was tested, how to add lolPing to it. */
function AgentNotes({ p }: { p: AgentProfile }) {
  const t = useText();
  const m = t.teammate.settings;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const snippet = await api.getTeammateAgentSnippet(p.id);
    if (snippet === null) return;
    try {
      await navigator.clipboard.writeText(snippet.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      {agentNotes(p.preset).map((n) => {
        switch (n.kind) {
          case 'approvals':
            return <span key={n.kind} className="desc mateNote">{m.agentApprovals[n.approvals]}</span>;
          case 'untested':
            return <span key={n.kind} className="desc mateNote">{m.agentUntested}</span>;
          case 'dsh':
            return <span key={n.kind} className="desc mateNote">{m.agentDsh}</span>;
          case 'addMcp':
            return (
              <div key={n.kind} className="mateRow mateNote">
                <span className="desc">
                  {n.file !== null ? m.agentAddMcpFile(n.file) : m.agentAddMcpCommand(n.bin)}
                </span>
                <Button size="small" onClick={() => void copy()}>
                  {copied ? m.agentSnippetCopied : m.agentCopySnippet}
                </Button>
              </div>
            );
        }
      })}
    </>
  );
}

/** A coding agent's profile: the command, where it runs, how long it may take, and what to know about it. */
export function AgentProfileCard({ p, open, onChange, onRemove }: {
  p: AgentProfile; open: boolean; onChange(patch: Partial<AgentProfile>): void; onRemove(): void;
}) {
  const t = useText();
  const m = t.teammate.settings;
  const preset = p.preset === 'custom' ? null : AGENT_PRESETS[p.preset];
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckAgentResult | null>(null);
  // Settings keep no agent without a command, so an empty field goes back to the saved one.
  const [commandReset, setCommandReset] = useState(0);
  const saved = p.customArgs.join('\n');
  const [args, setArgs] = useState(saved);
  useEffect(() => setArgs(saved), [saved]);
  useEffect(() => setResult(null), [p.command]);

  const check = async () => {
    setChecking(true);
    setResult(await api.checkTeammateAgent(p.id));
    setChecking(false);
  };

  return (
    <ExpanderRow icon={<Code24Regular />} title={p.name || preset?.name || m.agentCustom} defaultOpen={open}
      description={`${preset?.name ?? m.agentCustom} · ${p.command}`}>
      <div className="expPane">
        <div className="mateFields">
          <span>{m.profileName}</span>
          <DraftInput value={p.name} maxLength={60} onSave={(name) => onChange({ name })} />
          <span>{m.tagColor}</span>
          <Swatches label={m.tagColor} color={p.tagColorCustom ? -1 : p.tagColor}
            onPick={(i) => onChange({ tagColor: i, tagColorCustom: null })} />
          <span>{m.agentCommand}</span>
          <div className="mateRow">
            <DraftInput key={commandReset} value={p.command} maxLength={1024} width={300} onSave={(v) => {
              if (v.trim() === '') setCommandReset((n) => n + 1);
              else onChange({ command: v.trim() });
            }} />
            <Button disabled={checking} onClick={() => void check()}>{checking ? m.checking : m.agentCheck}</Button>
            {result ? <CheckResult r={result} /> : <span className="desc">{m.agentCheckDesc}</span>}
          </div>
          {preset === null ? (
            <>
              <span>{m.agentArgs}</span>
              <div className="mateStack">
                <Textarea value={args} resize="vertical" rows={3} aria-label={m.agentArgs}
                  style={{ width: '100%', fontFamily: 'monospace' }} onChange={(_, d) => setArgs(d.value)}
                  onBlur={() => {
                    const lines = linesOf(args);
                    if (lines.join('\n') !== saved) onChange({ customArgs: lines });
                  }} />
                <span className="desc">{m.agentArgsDesc}</span>
              </div>
            </>
          ) : null}
          <FolderRows p={p} onChange={onChange} />
          <span>{m.agentTimeout}</span>
          <div className="mateRow">
            <SpinButton min={1} max={30} step={1} value={timeoutMinutes(p.timeoutS)} style={{ width: 90 }}
              aria-label={m.agentTimeout}
              onChange={(_, d) => {
                const minutes = d.value ?? Number(d.displayValue);
                if (Number.isFinite(minutes)) onChange({ timeoutS: timeoutSeconds(minutes) });
              }} />
            <span className="desc">{m.agentTimeoutUnit}</span>
          </div>
        </div>
        <AgentNotes p={p} />
        <div className="mateRow mateNote">
          <Button appearance="subtle" onClick={onRemove}>{m.removeProfile}</Button>
        </div>
      </div>
    </ExpanderRow>
  );
}
