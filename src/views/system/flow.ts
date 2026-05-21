// Live agent flow page. Lazy wrapper around flow.tsx.

import type { Root } from 'react-dom/client';

let activeContainer: HTMLElement | null = null;
let activeRoot: Root | null = null;
let mountGeneration = 0;

export async function mount(container: HTMLElement, route?: unknown): Promise<void> {
  return _doMount(container, { route });
}

export async function mountScoped(container: HTMLElement, agentIds: string | string[]): Promise<void> {
  return _doMount(container, { filterIds: Array.isArray(agentIds) ? agentIds : [agentIds] });
}

async function _doMount(container: HTMLElement, appProps: Record<string, unknown>): Promise<void> {
  activeContainer = container;
  container.replaceChildren();

  const myGen = ++mountGeneration;

  const [{ createElement }, { createRoot }, flowMod] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./flow.tsx' as string),
  ]);
  const FlowApp = (flowMod as { default: unknown }).default;

  if (myGen !== mountGeneration || activeContainer !== container) {
    return;
  }

  activeRoot = createRoot(container);
  activeRoot.render(createElement(FlowApp as never, appProps));
}

export function unmount(): void {
  mountGeneration++;
  if (activeRoot) {
    try { activeRoot.unmount(); } catch { /* ignore */ }
    activeRoot = null;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}
