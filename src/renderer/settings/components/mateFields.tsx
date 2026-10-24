import { Input } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { TAG_COLORS } from '../../../shared/roomColors';
import { useText } from '../text';

export function Swatches({ label, color, onPick }: { label: string; color: number; onPick(i: number): void }) {
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
export function DraftInput({ value, onSave, maxLength, placeholder, width }: {
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
