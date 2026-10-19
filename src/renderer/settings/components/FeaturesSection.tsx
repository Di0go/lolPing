import {
  Bot24Regular, Chat24Regular, CheckboxChecked24Regular, Emoji24Regular, PeopleCommunity24Regular, People24Regular,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { FEATURES, featureVisible, type FeatureId } from '../../../shared/features';
import type { Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SwitchRow } from './rows';

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

/** One switch per optional feature this platform has. The room ones grey out while Rooms is off. */
export function FeaturesSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  return (
    <>
      {FEATURES.filter(({ id }) => featureVisible(id, api.platform)).map(({ id, requires }) => {
        const blocked = requires !== undefined && !s.features[requires];
        return (
          <SwitchRow key={id} icon={ICONS[id]} title={t.featureTitle[id]} dim={blocked} disabled={blocked}
            description={blocked ? `${t.featureDesc[id]} ${t.featureNeedsRooms}` : t.featureDesc[id]}
            checked={s.features[id]} onChange={(v) => {
              void update({ features: { ...s.features, [id]: v } }).then((r) => {
                if (r.ok && v && id === 'teammate') showTeammate();
              });
            }} />
        );
      })}
    </>
  );
}
