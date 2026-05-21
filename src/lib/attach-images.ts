// Image attachment manager for the chat composer.
//
// Usage:
//   const ctl = setupImageAttach({ container, textarea, fileInput,
//                                  canAttachImages, onChange });
//   ctl.getAttachments() => [{ kind:'image', name, size, mimeType, dataBase64 }]
//   ctl.clear()          - wipe all attachments and re-render
//   ctl.refreshSupport() - re-evaluate canAttachImages() and re-render notice
//   ctl.destroy()        - detach all listeners and remove DOM

const MAX_ATTACHMENTS = 5;
const MAX_BYTES       = 5 * 1024 * 1024;
const ALLOWED_MIME    = new Set<string>([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);

export interface Attachment {
  id: string;
  kind: 'image';
  name: string;
  size: number;
  mimeType: string;
  dataBase64: string;
  dataUrl: string;
}

export interface PublicAttachment {
  kind: 'image';
  name: string;
  size: number;
  mimeType: string;
  dataBase64: string;
}

export interface AttachChangeEvent {
  attachments: Attachment[];
  error?: string;
}

export interface SetupImageAttachOptions {
  container: HTMLElement;
  textarea?: HTMLTextAreaElement | null;
  fileInput?: HTMLInputElement | null;
  canAttachImages?: () => boolean;
  onChange?: (event: AttachChangeEvent) => void;
}

export interface AttachController {
  getAttachments(): PublicAttachment[];
  clear(): void;
  refreshSupport(): void;
  isSupported(): boolean;
  destroy(): void;
}

interface ShowErrorFn {
  (msg: string): void;
  _t?: ReturnType<typeof setTimeout>;
}

export function setupImageAttach(
  options: SetupImageAttachOptions,
): AttachController {
  const { container, textarea, fileInput, canAttachImages, onChange } = options;
  if (!container) throw new Error('setupImageAttach: container required');

  // Attachments are always supported now; the server saves them to
  // <cwd>/uploads/ and references them in the prompt text.
  const supported = (): boolean => true;
  void canAttachImages;

  const pills = document.createElement('div');
  pills.className = 'attach-pills hidden';
  container.appendChild(pills);

  const notice = document.createElement('div');
  notice.className = 'attach-notice hidden';
  container.appendChild(notice);

  let attachments: Attachment[] = [];
  let nextId = 1;
  let destroyed = false;

  function emit(event: Partial<AttachChangeEvent>): void {
    if (typeof onChange !== 'function') return;
    try { onChange({ attachments: attachments.slice(), ...(event || {}) } as AttachChangeEvent); }
    catch { /* ignore */ }
  }

  function emitError(msg: string): void {
    emit({ error: msg });
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function render(): void {
    pills.replaceChildren();
    if (!attachments.length) {
      pills.classList.add('hidden');
    } else {
      pills.classList.remove('hidden');
      for (const att of attachments) {
        const pill = document.createElement('div');
        pill.className = 'attach-pill';
        pill.dataset['id'] = att.id;

        const thumb = document.createElement('img');
        thumb.className = 'attach-pill-thumb';
        thumb.src = att.dataUrl;
        thumb.alt = att.name;
        pill.appendChild(thumb);

        const meta = document.createElement('div');
        meta.className = 'attach-pill-meta';
        const nm = document.createElement('div');
        nm.className = 'attach-pill-name';
        nm.textContent = att.name;
        const sz = document.createElement('div');
        sz.className = 'attach-pill-size';
        sz.textContent = fmtSize(att.size);
        meta.appendChild(nm);
        meta.appendChild(sz);
        pill.appendChild(meta);

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'attach-pill-remove';
        rm.setAttribute('aria-label', 'remove attachment');
        rm.textContent = 'x';
        rm.addEventListener('click', (ev: MouseEvent) => {
          ev.preventDefault();
          removeAttachment(att.id);
        });
        pill.appendChild(rm);

        pills.appendChild(pill);
      }
    }
    renderNotice();
  }

  function renderNotice(): void {
    notice.classList.add('hidden');
    notice.textContent = '';
  }

  const showError: ShowErrorFn = (msg: string): void => {
    notice.textContent = msg;
    notice.classList.remove('hidden');
    if (showError._t) clearTimeout(showError._t);
    showError._t = setTimeout(() => renderNotice(), 4000);
  };

  function removeAttachment(id: string): void {
    const before = attachments.length;
    attachments = attachments.filter((a) => a.id !== id);
    if (attachments.length !== before) {
      render();
      emit({});
    }
  }

  async function readAsDataUrl(blob: Blob): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = (): void => resolve(String(r.result || ''));
      r.onerror = (): void => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  function pickName(blob: File | Blob, fallback?: string): string {
    if (blob && typeof (blob as File).name === 'string' && (blob as File).name) return (blob as File).name;
    const ext = (blob && blob.type && blob.type.split('/')[1]) || 'bin';
    return `${fallback || 'pasted'}-${Date.now()}.${ext}`;
  }

  async function addBlob(blob: File | Blob | null | undefined, suggestedName?: string): Promise<boolean> {
    if (attachments.length >= MAX_ATTACHMENTS) {
      emitError(`Attachment limit (${MAX_ATTACHMENTS}) reached.`);
      return false;
    }
    if (!blob) return false;
    const mime = blob.type || '';
    if (!ALLOWED_MIME.has(mime)) {
      emitError(`Unsupported image type: ${mime || 'unknown'}.`);
      return false;
    }
    if (blob.size > MAX_BYTES) {
      emitError(`Image is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`);
      return false;
    }
    let dataUrl: string;
    try { dataUrl = await readAsDataUrl(blob); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitError(`Failed to read image: ${msg}`);
      return false;
    }
    const comma = dataUrl.indexOf(',');
    const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
    const name = pickName(blob, suggestedName);
    const att: Attachment = {
      id: 'att-' + (nextId++),
      kind: 'image',
      name,
      size: blob.size,
      mimeType: mime,
      dataBase64,
      dataUrl,
    };
    attachments.push(att);
    render();
    emit({});
    return true;
  }

  async function addFiles(files: File[] | FileList, sourceLabel?: string): Promise<void> {
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      if (destroyed) return;
      await addBlob(f, sourceLabel);
    }
  }

  async function onPaste(ev: ClipboardEvent): Promise<void> {
    if (destroyed) return;
    const items = ev?.clipboardData?.items;
    if (!items || !items.length) return;
    const blobs: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) blobs.push(f);
      }
    }
    if (!blobs.length) return;
    ev.preventDefault();
    for (const b of blobs) {
      await addBlob(b, 'pasted');
    }
  }

  let dragDepth = 0;
  function onDragEnter(ev: DragEvent): void {
    if (!hasImageDrag(ev)) return;
    ev.preventDefault();
    dragDepth++;
    container.classList.add('attach-dropping');
  }
  function onDragOver(ev: DragEvent): void {
    if (!hasImageDrag(ev)) return;
    ev.preventDefault();
    try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
  }
  function onDragLeave(ev: DragEvent): void {
    if (!hasImageDrag(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) container.classList.remove('attach-dropping');
  }
  async function onDrop(ev: DragEvent): Promise<void> {
    if (!ev.dataTransfer) return;
    const files = Array.from(ev.dataTransfer.files || []).filter((f) => f.type && f.type.startsWith('image/'));
    if (!files.length) {
      dragDepth = 0;
      container.classList.remove('attach-dropping');
      return;
    }
    ev.preventDefault();
    dragDepth = 0;
    container.classList.remove('attach-dropping');
    await addFiles(files, 'dropped');
  }
  function hasImageDrag(ev: DragEvent): boolean {
    const types = ev?.dataTransfer?.types;
    if (!types) return false;
    for (const t of Array.from(types)) {
      if (t === 'Files' || (typeof t === 'string' && t.startsWith('image/'))) return true;
    }
    return false;
  }

  async function onFileChange(ev: Event): Promise<void> {
    const target = ev?.target as HTMLInputElement | null;
    const files = target?.files;
    if (!files || !files.length) return;
    await addFiles(Array.from(files), 'file');
    try { if (target) target.value = ''; } catch { /* ignore */ }
  }

  if (textarea) textarea.addEventListener('paste', onPaste as unknown as EventListener);
  container.addEventListener('dragenter', onDragEnter as EventListener);
  container.addEventListener('dragover',  onDragOver as EventListener);
  container.addEventListener('dragleave', onDragLeave as EventListener);
  container.addEventListener('drop',      onDrop as unknown as EventListener);
  if (fileInput) fileInput.addEventListener('change', onFileChange as EventListener);

  render();
  void showError;

  return {
    getAttachments(): PublicAttachment[] {
      return attachments.map((a) => ({
        kind: a.kind,
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        dataBase64: a.dataBase64,
      }));
    },
    clear(): void {
      if (!attachments.length) { renderNotice(); return; }
      attachments = [];
      render();
      emit({});
    },
    refreshSupport(): void {
      renderNotice();
    },
    isSupported(): boolean { return supported(); },
    destroy(): void {
      destroyed = true;
      if (textarea) textarea.removeEventListener('paste', onPaste as unknown as EventListener);
      container.removeEventListener('dragenter', onDragEnter as EventListener);
      container.removeEventListener('dragover',  onDragOver as EventListener);
      container.removeEventListener('dragleave', onDragLeave as EventListener);
      container.removeEventListener('drop',      onDrop as unknown as EventListener);
      if (fileInput) fileInput.removeEventListener('change', onFileChange as EventListener);
      try { pills.remove(); } catch { /* ignore */ }
      try { notice.remove(); } catch { /* ignore */ }
      attachments = [];
    },
  };
}
