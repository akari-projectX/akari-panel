import { describe, expect, it } from 'vitest';
import { dismiss, dismissKey, dismissMark, isDismissed } from './notice-dismiss';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('notice dismissal', () => {
  it('keys per kind, marks per version', () => {
    expect(dismissKey('order')).toBe('akari.dismiss.order');
    expect(dismissKey('ticket')).toBe('akari.dismiss.ticket');
    expect(dismissMark('o1')).toBe('o1');
    expect(dismissMark('t1', '2026-10-29T00:00:00Z')).toBe('t1@2026-10-29T00:00:00Z');
  });

  it('an order stays hidden until it is a different order', () => {
    const s = memory();
    expect(isDismissed('order', 'o1', s)).toBe(false);
    dismiss('order', 'o1', s);
    expect(isDismissed('order', 'o1', s)).toBe(true);
    expect(isDismissed('order', 'o2', s)).toBe(false);
    expect(isDismissed('ticket', 'o1', s)).toBe(false);
  });

  it('a ticket comes back when a newer reply arrives', () => {
    const s = memory();
    dismiss('ticket', dismissMark('t1', 'a'), s);
    expect(isDismissed('ticket', dismissMark('t1', 'a'), s)).toBe(true);
    expect(isDismissed('ticket', dismissMark('t1', 'b'), s)).toBe(false);
  });

  it('a broken storage never hides a notice and never throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(() => dismiss('order', 'o1', broken)).not.toThrow();
    expect(isDismissed('order', 'o1', broken)).toBe(false);
    expect(isDismissed('order', 'o1', null)).toBe(false);
  });
});
