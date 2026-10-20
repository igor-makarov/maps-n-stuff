/**
 * Small DOM/format helpers shared by the optional app modules.
 * No framework, no dependencies (see coordination/README.md D2/D4).
 */

/** Create an element: el('div', { class: 'x' }, [child, 'text']). */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Escape text for use in an HTML string (only where innerHTML is required). */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Year or year range, honest about missing values. */
export function formatYear(year) {
  if (year === null || year === undefined || Number.isNaN(Number(year))) return 'Undated';
  const n = Number(year);
  return n < 0 ? `${Math.abs(n)} BCE` : String(n);
}

export function formatYearRange(start, end) {
  if (start && end && start !== end) return `${formatYear(start)}–${formatYear(end)}`;
  return formatYear(start ?? end);
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
/** Display catalogue language codes in English without rewriting source metadata. */
export function formatLanguage(value) {
  const language = String(value ?? '').trim();
  if (!language) return 'not stated';
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) return language;
  try { return languageNames.of(language) ?? language; }
  catch { return language; }
}

export function debounce(fn, wait = 250) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

/** Set state text on an element that is always in the accessibility tree. */
export function setStatus(node, message, kind = 'info') {
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
}

/** Minimal focus trap for the detail panel (Esc handled by the caller). */
export function trapFocus(container, event) {
  const focusables = qsa(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    container,
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Build an absolutised, shareable URL for the current state. */
export function permalink() {
  return window.location.href;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
