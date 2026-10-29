import { describe, expect, it, vi } from 'vitest';
import { chunk, intent } from './dialogs';

describe('dialogs', () => {
  it('a preloaded dialog is handed over synchronously; otherwise it is downloaded once', async () => {
    const mod = { default: 'Dialog' };
    const load = vi.fn(() => Promise.resolve(mod));
    const first = chunk(load);
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBe(mod);
    expect(chunk(load)).toBe(mod);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('pointer and focus on the trigger start the download; detaching stops listening', async () => {
    const mod = { default: 'Dialog' };
    const load = vi.fn(() => Promise.resolve(mod));
    const el = new EventTarget() as HTMLElement;
    const detach = intent(load)(el);
    el.dispatchEvent(new Event('pointerenter'));
    el.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(chunk(load)).toBe(mod));

    const other = vi.fn(() => Promise.resolve(mod));
    const off = intent(other)(el);
    if (typeof off === 'function') off();
    if (typeof detach === 'function') detach();
    el.dispatchEvent(new Event('pointerdown'));
    expect(other).not.toHaveBeenCalled();
  });
});
