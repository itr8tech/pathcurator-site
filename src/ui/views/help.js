// src/ui/views/help.js — #/help: the in-app documentation. Landing page = guide cards (ordered,
// task-first) + a compact reference list; #/help/<topic> renders one topic through the app's own
// markdown sanitizer, with related-topic chips (internal links are rendered here, not in
// markdown — fragment hrefs don't pass the URL sanitizer, by design).
import { el, clear } from '../dom.js';
import { GUIDES, REFERENCES, topicById } from '../help-content.js';

export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content help-view' });
  container.append(root);
  const controller = { title: 'Help', refresh, destroy() {} };

  const chip = (t) => el('a', { class: 'help-chip', href: `#/help/${t.id}` }, t.title);

  function landing() {
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Help'));
    root.append(el('p', { class: 'muted' }, 'Short guides for getting things done, and references for the details. Start at the top if you’re new.'));
    root.append(el('h2', {}, 'Guides'));
    const grid = el('div', { class: 'help-grid' });
    GUIDES.forEach((t, i) => grid.append(el('a', { class: 'help-card card', href: `#/help/${t.id}`, 'data-help-card': t.id },
      el('span', { class: 'help-card__num', 'aria-hidden': 'true' }, String(i + 1)),
      el('strong', {}, t.title),
      el('p', { class: 'muted' }, t.blurb))));
    root.append(grid);
    root.append(el('h2', {}, 'References'));
    const list = el('ul', { class: 'help-reflist', role: 'list' });
    for (const t of REFERENCES) list.append(el('li', {},
      el('a', { href: `#/help/${t.id}` }, t.title), ' ', el('span', { class: 'muted' }, `— ${t.blurb}`)));
    root.append(list);
  }

  function topicPage(topic) {
    controller.title = topic.title;
    root.append(el('p', { class: 'help-crumb' }, el('a', { href: '#/help' }, '← All guides & references')));
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, topic.title));
    root.append(el('div', { class: 'prose help-body' }, ctx.md.renderMarkdown(topic.body)));
    const related = (topic.related || []).map(topicById).filter(Boolean);
    if (related.length) root.append(el('p', { class: 'help-related' },
      el('span', { class: 'muted' }, 'Related: '), ...related.map(chip)));
    // simple next-guide flow for the guide sequence
    const gi = GUIDES.findIndex((g) => g.id === topic.id);
    if (gi >= 0 && gi < GUIDES.length - 1) root.append(el('p', {},
      el('a', { class: 'btn', href: `#/help/${GUIDES[gi + 1].id}` }, `Next guide: ${GUIDES[gi + 1].title} →`)));
  }

  async function refresh() {
    clear(root);
    const topic = params.topic ? topicById(params.topic) : null;
    if (params.topic && !topic) {
      root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Topic not found'),
        el('p', {}, el('a', { href: '#/help' }, 'Back to Help')));
      return;
    }
    topic ? topicPage(topic) : landing();
  }

  await refresh();
  return controller;
}
