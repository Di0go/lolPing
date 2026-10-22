import { describe, expect, it } from 'vitest';
import { checkedIds } from '../../src/renderer/teammate/formChoice';

const rows = [
  { id: 'a', label: 'Name', value: 'Ada', checked: true },
  { id: 'b', label: 'Email', value: 'ada@example.com', checked: true },
  { id: 'c', label: 'Phone', value: '555', checked: false },
];

describe('checkedIds', () => {
  it('starts from the rows as the preview sent them', () => {
    expect(checkedIds(rows, {})).toEqual(['a', 'b']);
  });

  it('follows what the user ticked and cleared, in the order of the rows', () => {
    expect(checkedIds(rows, { a: false, c: true })).toEqual(['b', 'c']);
  });

  it('ignores a choice for a row that is no longer listed', () => {
    expect(checkedIds(rows, { gone: true })).toEqual(['a', 'b']);
  });

  it('is empty when every row is cleared', () => {
    expect(checkedIds(rows, { a: false, b: false })).toEqual([]);
  });
});
