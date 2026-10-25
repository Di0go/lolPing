import { Button } from '@fluentui/react-components';
import { useState } from 'react';
import { CONNECT_APPS } from '../../../shared/teammate/connectApps';
import { api } from '../api';
import { useText } from '../text';
import { SettingRow } from './rows';

/** Apps that run agents outside lolPing: where to add lolPing, and a Copy button for the snippet that app reads. */
export function ConnectApps() {
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
    <>
      <SettingRow icon={null} title={m.connectTitle} description={m.connectDesc}>{null}</SettingRow>
      {CONNECT_APPS.map((a) => (
        <SettingRow key={a.id} icon={null} title={m.connectName[a.id]} description={(
          <>
            <span className="matePath">{a.file ? a.file[api.platform] : m.connectPage[a.page]}</span>
            {failed === a.id ? <span className="weImportError">{m.connectFailed}</span> : null}
          </>
        )}>
          <Button size="small" aria-label={m.connectCopyLabel(m.connectName[a.id])} onClick={() => void copy(a.id)}>
            {copied === a.id ? m.connectCopied : m.connectCopy}
          </Button>
        </SettingRow>
      ))}
    </>
  );
}
