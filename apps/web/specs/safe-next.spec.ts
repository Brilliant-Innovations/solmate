import fc from 'fast-check';
import { safeNext } from '../src/lib/safe-next';

describe('safeNext (open-redirect guard, R2-06)', () => {
  it('accepts same-app paths and rejects every authority-smuggling form', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/settings?notice=x')).toBe('/settings?notice=x');
    expect(safeNext('/positions/abc#lot')).toBe('/positions/abc#lot');
    for (const bad of [undefined, null, '', 'https://evil.example', '//evil.example/x', '/\\evil.example', '/%2f%2fevil.example', '/%5cevil', '/a b', '/a\nb', 'evil.example', '\\\\evil']) {
      expect(safeNext(bad)).toBe('/');
    }
  });

  it('never returns something that could leave the origin', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = safeNext(s);
        expect(out.startsWith('/')).toBe(true);
        expect(out.startsWith('//')).toBe(false);
        expect(out.includes('\\')).toBe(false);
      }),
    );
  });
});
