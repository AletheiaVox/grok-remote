// Image lightbox.
//
// Opens an image fullscreen-ish in a modal. Click outside the image,
// press Escape, or click the close button to dismiss. Single instance
// at a time; opening a new one replaces the current one.

import { el } from './render.js';

interface ActiveLightbox {
  overlay: HTMLDivElement;
  prevOverflow: string;
}

let active: ActiveLightbox | null = null;

export function openImageLightbox(src: string, alt: string = ''): void {
  closeImageLightbox();
  if (!src) return;

  const img = el('img', {
    class: 'image-lightbox__img',
    src,
    alt,
    onclick: (ev: MouseEvent) => { ev.stopPropagation(); },
  }) as HTMLImageElement;

  const closeBtn = el('button', {
    type: 'button',
    class: 'image-lightbox__close',
    title: 'close',
    'aria-label': 'close',
    onclick: closeImageLightbox,
  }, '×') as HTMLButtonElement;

  const overlay = el('div', {
    class: 'image-lightbox',
    role: 'dialog',
    'aria-label': alt || 'image preview',
    onclick: closeImageLightbox,
  }, img, closeBtn) as HTMLDivElement;

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  active = { overlay, prevOverflow };
  requestAnimationFrame(() => overlay.classList.add('image-lightbox--show'));
}

export function closeImageLightbox(): void {
  if (!active) return;
  const { overlay, prevOverflow } = active;
  active = null;
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = prevOverflow || '';
  overlay.classList.remove('image-lightbox--show');
  setTimeout(() => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }, 160);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeImageLightbox();
}
