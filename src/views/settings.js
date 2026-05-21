// Settings view.
//
// Two-pane shell:
//   - left: sub-nav grouped by section (general, native config, tools)
//   - right: active sub-page content
//
// The "general" sub-page is the original settings form (default model,
// default cwd, auto-approve, debug, retention, theme). Every other
// sub-page is one of the system page modules (plugins, hooks,
// marketplaces, etc.), mounted into the content host via its existing
// mount(container) / unmount() API. SettingsView never knows what's
// inside those pages.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { iconHtml } from '../lib/icons.js';
import { THEMES, getTheme, setTheme } from '../lib/themes';
import { SETTINGS_SECTIONS, getSettingsPage } from './system/index.js';

function clampInt(raw, min, max, fallback) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export class SettingsView {
  constructor() {
    this.settings = {};
    this.models   = [];

    this._activeArea     = 'general';
    this._mountedModule  = null;       // the system-page module currently
                                        // owning the content host, if any
    this._navButtons     = new Map();  // area -> button (for active state)

    this._buildGeneralFormPieces();
    this.generalForm = this._buildGeneralFormRoot();

    this.contentHost = el('div', { class: 'settings-content' });
    this.subnav = this._buildSubnav();

    this.root = el('section', { class: 'settings-shell' },
      this.subnav,
      this.contentHost,
    );
  }

  // ── public lifecycle (called by main.js router) ──────────────────────

  mount(parent) {
    if (this.root.parentNode !== parent) {
      parent.appendChild(this.root);
    }
    // mount() does not pick a sub-page on its own; the router calls
    // setActive() right after to apply the route's sub.
  }

  unmount() {
    this._teardownMountedModule();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  // Switch the active sub-page. Cheap to call repeatedly with the same
  // area: returns early.
  setActive(area) {
    const next = area || 'general';
    if (next === this._activeArea && this.contentHost.children.length) return;
    this._activeArea = next;
    this._refreshSubnavActive();
    this._renderActive();
  }

  // ── sub-nav ──────────────────────────────────────────────────────────

  _buildSubnav() {
    const nav = el('nav', { class: 'settings-subnav', 'aria-label': 'settings sections' });
    for (const section of SETTINGS_SECTIONS) {
      nav.appendChild(el('div', { class: 'settings-subnav__section-title' }, section.title));
      const list = el('ul', { class: 'settings-subnav__list' });
      for (const item of section.items) {
        const btn = el('a', {
          class: 'settings-subnav__item',
          href: `#/settings/${item.area}`,
          'data-area': item.area,
        },
          el('span', { class: 'settings-subnav__ico', innerHTML: iconHtml(item.iconName || 'settings') }),
          el('span', { class: 'settings-subnav__lbl' }, item.label),
        );
        this._navButtons.set(item.area, btn);
        list.appendChild(el('li', {}, btn));
      }
      nav.appendChild(list);
    }
    return nav;
  }

  _refreshSubnavActive() {
    for (const [area, btn] of this._navButtons) {
      btn.classList.toggle('settings-subnav__item--active', area === this._activeArea);
    }
  }

  // ── content rendering ────────────────────────────────────────────────

  _renderActive() {
    this._teardownMountedModule();
    this.contentHost.replaceChildren();

    if (this._activeArea === 'general') {
      this.contentHost.appendChild(this.generalForm);
      this.refreshThemePicker();
      this.load();
      return;
    }

    const page = getSettingsPage(this._activeArea);
    if (!page || !page.module || typeof page.module.mount !== 'function') {
      this.contentHost.appendChild(
        el('div', { class: 'pane-empty' }, `no view for "${this._activeArea}"`),
      );
      return;
    }
    page.module.mount(this.contentHost, { area: this._activeArea });
    this._mountedModule = page.module;
  }

  _teardownMountedModule() {
    if (!this._mountedModule) return;
    if (typeof this._mountedModule.unmount === 'function') {
      try { this._mountedModule.unmount(); } catch { /* ignore */ }
    }
    this._mountedModule = null;
  }

  // ── general settings form (the legacy SettingsView content) ──────────

  _buildGeneralFormPieces() {
    this.modelInput   = el('input', { class: 'inp', type: 'text', placeholder: 'grok-build' });
    this.modelSelect  = null;
    this.cwdInput     = el('input', { class: 'inp', type: 'text', placeholder: '/path/to/working/dir' });
    this.autoApprove  = el('input', { type: 'checkbox' });
    this.debugToggle  = el('input', { type: 'checkbox' });
    this.retentionInput = el('input', {
      class: 'inp inp--num', type: 'number', min: '0', max: '3650', step: '1', placeholder: '30',
    });
    this.themePicker = this._buildThemePicker();
    this.statusEl = el('div', { class: 'settings-status' });

    this.saveBtn = el('button', {
      class: 'btn btn--primary',
      onclick: (ev) => { ev.preventDefault(); this.save(); },
    }, 'save');
    this.reloadBtn = el('button', {
      class: 'btn btn--ghost',
      onclick: (ev) => { ev.preventDefault(); this.load(); },
    }, 'reload');

    this.modelFieldHost = el('div', { class: 'field-host' }, this.modelInput);
  }

  _buildGeneralFormRoot() {
    return el('section', { class: 'settings' },
      el('h2', { class: 'settings-title' }, 'general'),
      this.statusEl,

      this.field('default model', this.modelFieldHost,
        'used when you spawn a new agent without specifying one.'),
      this.field('default cwd', this.cwdInput,
        'fallback working directory for new agents.'),
      this.field('auto-approve tools',
        el('label', { class: 'toggle' }, this.autoApprove,
          el('span', { class: 'toggle-text' }, 'on')),
        'server already passes --always-approve. shown here for visibility.'),
      this.field('debug controls',
        el('label', { class: 'toggle' }, this.debugToggle,
          el('span', { class: 'toggle-text' }, 'show developer affordances')),
        'shows the { payload } button in the composer to inspect the exact JSON sent to the agent.'),
      this.field('history retention (days)', this.retentionInput,
        'agent history under ~/.grok-remote/agents/ is pruned when last activity exceeds this. starred agents are never pruned. 0 disables cleanup. default 30.'),
      this.field('theme', this.themePicker,
        'applies instantly. saved in this browser only.'),

      el('div', { class: 'settings-actions' }, this.saveBtn, this.reloadBtn),
    );
  }

  field(label, control, help) {
    return el('div', { class: 'field' },
      el('label', { class: 'field-label' }, label),
      control,
      help ? el('div', { class: 'field-help' }, help) : null,
    );
  }

  refreshThemePicker() {
    const current = getTheme();
    for (const [k, card] of Object.entries(this.themeCards || {})) {
      card.classList.toggle('theme-card--selected', k === current);
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = (k === current);
    }
  }

  async load() {
    this.setStatus('loading...', 'idle');
    try {
      const [settings, modelsResp] = await Promise.allSettled([
        api.getSettings(),
        api.models(),
      ]);
      if (settings.status === 'fulfilled' && settings.value) {
        this.settings = settings.value || {};
        this.modelInput.value  = this.settings.defaultModel || '';
        this.cwdInput.value    = this.settings.defaultCwd   || '';
        this.autoApprove.checked = !!this.settings.autoApprove;
        this.debugToggle.checked = !!this.settings.debug;
        const rd = (this.settings.retentionDays != null) ? Number(this.settings.retentionDays) : 30;
        this.retentionInput.value = Number.isFinite(rd) ? String(Math.max(0, Math.min(3650, rd))) : '30';
      } else {
        this.setStatus('settings unreachable · using defaults', 'warn');
      }

      let models = [];
      if (modelsResp.status === 'fulfilled' && modelsResp.value) {
        const m = modelsResp.value;
        if (Array.isArray(m)) models = m;
        else if (Array.isArray(m.models)) models = m.models;
      }
      this.models = models;
      this.swapModelField();
      if (settings.status === 'fulfilled') this.setStatus('loaded', 'ok');
    } catch (e) {
      this.setStatus(`load failed: ${e.message}`, 'fail');
    }
  }

  swapModelField() {
    if (Array.isArray(this.models) && this.models.length) {
      const sel = el('select', { class: 'inp' });
      const cur = this.modelInput.value || this.settings.defaultModel || '';
      sel.appendChild(el('option', { value: '' }, '(unset)'));
      for (const m of this.models) {
        const id = typeof m === 'string' ? m : (m.id || m.name || m.modelId);
        if (!id) continue;
        const opt = el('option', { value: id }, id);
        if (id === cur) opt.selected = true;
        sel.appendChild(opt);
      }
      const customRow = el('div', { class: 'model-custom' },
        el('span', { class: 'model-custom-label' }, 'or custom:'),
        this.modelInput,
      );
      this.modelSelect = sel;
      this.modelFieldHost.replaceChildren(sel, customRow);
    } else {
      this.modelFieldHost.replaceChildren(this.modelInput);
    }
  }

  async save() {
    const body = {
      defaultModel: this.modelSelect && this.modelSelect.value
        ? this.modelSelect.value
        : (this.modelInput.value.trim() || null),
      defaultCwd:   this.cwdInput.value.trim() || null,
      autoApprove:  !!this.autoApprove.checked,
      debug:        !!this.debugToggle.checked,
      retentionDays: clampInt(this.retentionInput.value, 0, 3650, 30),
      theme:        getTheme(),
    };
    this.saveBtn.disabled = true;
    this.setStatus('saving...', 'idle');
    try {
      const updated = await api.patchSettings(body);
      this.settings = updated || body;
      this.setStatus('saved', 'ok');
      window.dispatchEvent(new CustomEvent('grok-remote:settings-change', {
        detail: this.settings,
      }));
    } catch (e) {
      this.setStatus(`save failed: ${e.message}`, 'fail');
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  setStatus(text, kind) {
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${kind || 'idle'}` }, '·'),
      el('span', { class: 'settings-status-text' }, text),
    );
  }

  _buildThemePicker() {
    const current = getTheme();
    const grid = el('div', { class: 'theme-grid' });
    this.themeCards = {};
    for (const t of THEMES) {
      const isSel = t.name === current;
      const card = el('label', {
        class: `theme-card${isSel ? ' theme-card--selected' : ''}`,
      },
        el('input', {
          type: 'radio',
          name: 'theme',
          value: t.name,
          checked: isSel,
          onchange: () => {
            setTheme(t.name);
            this.refreshThemePicker();
            window.dispatchEvent(new CustomEvent('grok-remote:theme-change', {
              detail: { theme: t.name },
            }));
          },
        }),
        el('span', { class: 'theme-card-swatch', style: `background: ${t.accent}` }),
        el('span', { class: 'theme-card-label' }, t.label),
      );
      this.themeCards[t.name] = card;
      grid.appendChild(card);
    }
    return grid;
  }
}
