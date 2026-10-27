import { describe, expect, it } from 'vitest';
import { enabledFormats, importLinks, withFormat } from './sub-links';

const URL = 'https://sub.example.com/abc/token123';

describe('subscription formats', () => {
  it('lists auto first, then only the formats the site has on', () => {
    expect(enabledFormats({ sub_formats: ['links', 'surfboard', 'clash'] })).toEqual(['auto', 'clash', 'surfboard', 'links']);
    expect(enabledFormats(undefined)).toEqual(['auto']);
  });

  it('adds ?format= (or &format=) except for auto', () => {
    expect(withFormat(URL, 'auto')).toBe(URL);
    expect(withFormat(URL, 'surge')).toBe(`${URL}?format=surge`);
    expect(withFormat(`${URL}?x=1`, 'surfboard')).toBe(`${URL}?x=1&format=surfboard`);
  });
});

describe('one-click import deep links', () => {
  it('Surge and Surfboard import their own format through install-config', () => {
    const [surge, surfboard] = importLinks(URL, 'Akari', ['surge', 'surfboard']);
    expect(surge.href).toBe(`surge:///install-config?url=${encodeURIComponent(`${URL}?format=surge`)}`);
    expect(surfboard.href).toBe(`surfboard:///install-config?url=${encodeURIComponent(`${URL}?format=surfboard`)}`);
  });

  it('keeps the panel\'s order and skips ids it does not know', () => {
    expect(importLinks(URL, 'Akari', ['surfboard', 'nope', 'stash']).map((l) => l.id)).toEqual(['surfboard', 'stash']);
  });
});
