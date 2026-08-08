// src/ui/views/notfound.js
import { el } from '../dom.js';
export default async function mount(container) {
  container.append(el('div', { class: 'view-content' },
    el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Page not found'),
    el('p', { class: 'muted' }, 'That page does not exist.'),
    el('p', {}, el('a', { href: '#/' }, 'Return to the dashboard'))));
  return { title: 'Not found', refresh() {}, destroy() {} };
}
