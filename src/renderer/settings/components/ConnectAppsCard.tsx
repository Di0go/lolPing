import { Button } from '@fluentui/react-components';
import { PlugConnected24Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { CONNECT_APPS } from '../../../shared/teammate/connectApps';
import { api } from '../api';
import { useText } from '../text';

/** Apps that run agents outside lolPing: where to add lolPing, and a Copy button for the snippet that app reads. */
export function ConnectAppsCard() {
  const t = useText();
  const m = t.teammate.settings;
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const copy = async (id: string) => {
    setCopied(null);
    setFailed(null);
    const snippet = await api.getTeammateConnectSnippet(id);
    try {
      if (snippet === null) throw new Error('no snippet');
      await navigator.clipboard.writeText(snippet.text);
      setCopied(id);
    } catch {
      setFailed(id);
    }
  };

  return (
    <div className="card mate">
      <div className="mateHead">
        <span className="icon"><PlugConnected24Regular /></span>
        <div className="lbl">
          {m.connectTitle}
          <span className="desc">{m.connectDesc}</span>
        </div>
      </div>
      {CONNECT_APPS.map((a) => (
        <div key={a.id} className="mateRead">
          <span className="icon" />
          <div className="lbl">
            {a.name}
            <span className="desc matePath">{a.file ? a.file[api.platform] : m.connectPage[a.page]}</span>
            {failed === a.id ? <span className="weImportError">{m.connectFailed}</span> : null}
          </div>
          <Button size="small" aria-label={m.connectCopyLabel(a.name)} onClick={() => void copy(a.id)}>
            {copied === a.id ? m.connectCopied : m.connectCopy}
          </Button>
        </div>
      ))}
    </div>
  );
}
