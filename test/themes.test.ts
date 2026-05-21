import test from 'node:test';
import assert from 'node:assert/strict';

// themes.ts touches localStorage and document — both browser globals. Install
// minimal shims on globalThis before the module's first import. They mimic the
// just-enough surface area the module uses (getItem/setItem and a
// documentElement with a dataset bag).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string): string | null => store.has(k) ? store.get(k)! : null,
  setItem: (k: string, v: string): void => { store.set(k, String(v)); },
  removeItem: (k: string): void => { store.delete(k); },
  clear: (): void => store.clear(),
  key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
  get length(): number { return store.size; },
} as Storage;

const docDataset: Record<string, string> = {};
(globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document = {
  documentElement: { dataset: docDataset },
};

const themes = await import('../src/lib/themes.js');

test('THEMES exposes the four known themes', () => {
  const names = themes.THEMES.map((t) => t.name).sort();
  assert.deepEqual(names, ['dark', 'hacker', 'light', 'unicorn']);
});

test('getTheme returns the default when no value is stored', () => {
  store.clear();
  assert.equal(themes.getTheme(), 'dark');
});

test('getTheme returns the stored value when it is a known theme', () => {
  store.clear();
  store.set('grok-remote.theme', 'hacker');
  assert.equal(themes.getTheme(), 'hacker');
});

test('getTheme falls back to default when the stored value is unknown', () => {
  store.clear();
  store.set('grok-remote.theme', 'midnight-mango');
  assert.equal(themes.getTheme(), 'dark');
});

test('setTheme persists known themes and rejects unknowns by falling back to default', () => {
  store.clear();
  assert.equal(themes.setTheme('light'), 'light');
  assert.equal(store.get('grok-remote.theme'), 'light');

  assert.equal(themes.setTheme('not-a-theme'), 'dark');
  assert.equal(store.get('grok-remote.theme'), 'dark');
});

test('applyTheme writes the data-theme attribute on documentElement', () => {
  themes.applyTheme('hacker');
  assert.equal(docDataset.theme, 'hacker');
  themes.applyTheme('unicorn');
  assert.equal(docDataset.theme, 'unicorn');
});

test('applyTheme normalizes unknown themes to default before writing', () => {
  themes.applyTheme('nonsense');
  assert.equal(docDataset.theme, 'dark');
});

test('nextTheme cycles through the registry in declaration order', () => {
  store.clear();
  store.set('grok-remote.theme', 'dark');
  assert.equal(themes.nextTheme('dark'),    'light');
  assert.equal(themes.nextTheme('light'),   'hacker');
  assert.equal(themes.nextTheme('hacker'),  'unicorn');
  assert.equal(themes.nextTheme('unicorn'), 'dark');
});

test('getThemeMeta returns the matching theme record', () => {
  const meta = themes.getThemeMeta('hacker');
  assert.equal(meta.name, 'hacker');
  assert.equal(meta.label, 'hacker');
  assert.equal(meta.accent, '#00ff41');
});

test('getThemeMeta falls back to the first theme for unknown names', () => {
  const meta = themes.getThemeMeta('mystery');
  assert.equal(meta.name, 'dark');
});
