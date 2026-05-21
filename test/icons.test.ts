import test from 'node:test';
import assert from 'node:assert/strict';

import { ICONS, iconHtml } from '../src/lib/icons.js';

test('iconHtml returns an empty string for unknown icon names', () => {
  assert.equal(iconHtml('not-a-real-icon'), '');
  assert.equal(iconHtml(''), '');
});

test('iconHtml returns the matching SVG markup for known icons', () => {
  const svg = iconHtml('home');
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /aria-hidden="true"/);
});

test('all registered icons wrap into a <svg> with the shared viewBox and accessibility hint', () => {
  for (const [name, markup] of Object.entries(ICONS)) {
    assert.ok(markup.startsWith('<svg'), `${name} should start with <svg`);
    assert.match(markup, /viewBox="0 0 20 20"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /stroke="currentColor"/);
    assert.ok(markup.endsWith('</svg>'), `${name} should end with </svg>`);
  }
});

test('icon registry covers the rail-required names', () => {
  // These are the icon names src/main.ts and src/views/system/index.ts depend
  // on for the left rail and settings sidebar. If any of them is missing the
  // rail renders as a blank stripe.
  const required = ['home', 'mcp', 'memory', 'models', 'leaders', 'settings'];
  for (const name of required) {
    assert.ok(iconHtml(name).length > 0, `expected icon "${name}" to be registered`);
  }
});
