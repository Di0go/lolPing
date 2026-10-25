import type { PreviewRow } from '../../shared/teammate/doRules';

/** The ids to fill: each row's own default, unless the user ticked or cleared it. Keeps the order of the rows. */
export function checkedIds(rows: readonly PreviewRow[], choice: Readonly<Record<string, boolean>>): string[] {
  return rows.filter((r) => choice[r.id] ?? r.checked).map((r) => r.id);
}
