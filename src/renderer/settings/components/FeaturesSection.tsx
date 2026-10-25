import {
  Bot24Regular, Chat24Regular, CheckboxChecked24Regular, Emoji24Regular, PeopleCommunity24Regular, People24Regular,
} from '@fluentui/react-icons';
import { useState, type ReactNode } from 'react';
import { featureGroups, type FeatureId } from '../../../shared/features';
import type { Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { FirstRunDialog } from './FirstRunDialog';
import { ExpanderRow, OnOffSwitch, SwitchRow } from './rows';

const ICONS: Record<FeatureId, ReactNode> = {
  teammate: <Bot24Regular />,
  emotes: <Emoji24Regular />,
  rooms: <PeopleCommunity24Regular />,
  roomText: <Chat24Regular />,
  roomVotes: <CheckboxChecked24Regular />,
  roomPanel: <People24Regular />,
};

/** Switching the teammate on shows its section, which only renders once the new settings are in. */
const showTeammate = (): void => {
  requestAnimationFrame(() => document.getElementById('teammate')?.scrollIntoView({ behavior: 'smooth' }));
};

/** One switch per optional feature this platform has. A feature others require opens to show theirs, greyed out while it's off. */
export function FeaturesSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const [firstRun, setFirstRun] = useState(false);
  const set = (id: FeatureId, v: boolean) => {
    const features = { ...s.features, [id]: v };
    const first = id === 'teammate' && v && !s.teammate.firstRunDone;
    // The card is done once it opens: closing Settings with it open must not bring it back next time.
    void update(first ? { features, teammate: { ...s.teammate, firstRunDone: true } } : { features }).then((r) => {
      if (!r.ok || !v || id !== 'teammate') return;
      showTeammate();
      if (first) setFirstRun(true);
    });
  };
  return (
    <>
      {firstRun ? <FirstRunDialog settings={s} update={update} onClose={() => setFirstRun(false)} /> : null}
      {featureGroups(api.platform).map(({ id, parts }) => {
        if (parts.length === 0) {
          return <SwitchRow key={id} icon={ICONS[id]} title={t.featureTitle[id]} description={t.featureDesc[id]}
            checked={s.features[id]} onChange={(v) => set(id, v)} />;
        }
        const off = !s.features[id];
        return (
          <ExpanderRow key={id} icon={ICONS[id]} title={t.featureTitle[id]} description={t.featureDesc[id]}
            control={<OnOffSwitch checked={s.features[id]} label={t.featureTitle[id]} onChange={(v) => set(id, v)} />}>
            {parts.map((part) => (
              <SwitchRow key={part} icon={ICONS[part]} title={t.featureTitle[part]} dim={off} disabled={off}
                description={off ? `${t.featureDesc[part]} ${t.featureNeedsRooms}` : t.featureDesc[part]}
                checked={s.features[part]} onChange={(v) => set(part, v)} />
            ))}
          </ExpanderRow>
        );
      })}
    </>
  );
}
