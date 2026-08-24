// Keyboard-first live search for dynamic content, with in-page content
// management (add / edit / delete sections) and match highlighting.
//
// - The search box is always visible at the top; typing anywhere focuses it.
// - Content inside #content is split into sections (heading + following
//   blocks until the next heading), so any markup works - no fixed classes.
// - Tab / arrows move between the copy buttons of the visible sections and
//   Enter on a button copies it.
// - While typing, every match inside the visible sections is highlighted.
// - Ctrl+I opens a modal to add a new section (title + commands).
// - Ctrl+E edits the section that contains the currently focused element.
// - Delete removes that section (after confirmation).
// - Custom sections plus edits/deletes are persisted in localStorage.
console.log('script.js (keyboard-first instant search + content manager) loading...');

const copyIcon = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
const checkIcon = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

const HEADING_RE = /^H[1-6]$/;
// Elements treated as one indivisible search block (never descended into for
// headings). Anything else without direct text is a transparent wrapper.
const ATOMIC_TAGS = new Set([
    'PRE', 'TABLE', 'FIGURE', 'HR', 'IMG', 'SVG',
    'VIDEO', 'AUDIO', 'IFRAME', 'CANVAS'
]);

const STORAGE_KEY = 'freebuff_sections_v1';

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM ready - initializing');

    const content = document.getElementById('content');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');

    const editorModal = document.getElementById('editor-modal');
    const modalTitleEl = document.getElementById('modal-title');
    const modalHeading = document.getElementById('modal-heading');
    const modalCommands = document.getElementById('modal-commands');
    const modalSave = document.getElementById('modal-save');
    const modalDelete = document.getElementById('modal-delete');
    const modalCancel = document.getElementById('modal-cancel');
    const modalClose = document.getElementById('modal-close');
    const modalTags = document.getElementById('modal-tags');
    const modalCommandTags = document.getElementById('modal-command-tags');

    if (!content || !searchInput || !searchCount || !editorModal ||
        !modalHeading || !modalCommands || !modalSave || !modalDelete || !modalTags || !modalCommandTags) {
        console.error('Required elements not found', { content, searchInput, searchCount, editorModal });
        return;
    }

    let modalMode = 'add';
    let modalKey = null;

    // ------------------------------------------------------------------
    // Copy buttons (generic: every <pre><code> gets one)
    // ------------------------------------------------------------------
    function ensureCopyButtons() {
        content.querySelectorAll('pre').forEach(pre => {
            if (pre.querySelector('.copy-btn')) return; // avoid duplicates
            const code = pre.querySelector('code');
            if (!code) return;
            const rawText = code.textContent;
            const button = document.createElement('button');
            button.className = 'copy-btn';
            button.type = 'button';
            button.innerHTML = copyIcon;
            button.setAttribute('tabindex', '0');
            button.setAttribute('aria-label', 'Copy code to clipboard');
            button.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(rawText);
                    button.innerHTML = checkIcon;
                    setTimeout(() => (button.innerHTML = copyIcon), 1600);
                } catch (err) {
                    console.error('Clipboard write failed', err);
                }
            });
            pre.appendChild(button);
        });
    }

    // ------------------------------------------------------------------
    // Generic section discovery (no fixed class names)
    // ------------------------------------------------------------------
    function isHeading(el) {
        return HEADING_RE.test(el.tagName);
    }

    function hasDirectText(el) {
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
                return true;
            }
        }
        return false;
    }

    // Walk the live DOM and build sections:
    //   { heading: HTMLElement|null, body: HTMLElement[] }
    function collectUnits(root) {
        const units = [];
        let current = null;

        const ensureCurrent = (el) => {
            if (!current) {
                current = { heading: null, body: [] };
                units.push(current);
            }
            current.body.push(el);
        };

        const visit = (el) => {
            if (isHeading(el)) {
                current = { heading: el, body: [] };
                units.push(current);
                return;
            }
            if (el.classList && (el.classList.contains('section-tags') || el.classList.contains('command-tags'))) {
                ensureCurrent(el);
                return;
            }
            if (ATOMIC_TAGS.has(el.tagName)) {
                ensureCurrent(el);
                return;
            }
            if (hasDirectText(el)) {
                ensureCurrent(el);
                return;
            }
            for (const child of el.children) {
                visit(child);
            }
        };

        for (const child of root.children) {
            visit(child);
        }
        return units;
    }

    // ------------------------------------------------------------------
    // Alphabetical sorting (Feature: re-order sections by title)
    // ------------------------------------------------------------------
    function compareSectionTitles(a, b) {
        return String(a).localeCompare(String(b), undefined, {
            sensitivity: 'base',
            numeric: true
        });
    }

    // Physically re-order the sections inside #content so they stay in
    // alphabetical order after edits / additions. Items without a heading
    // (leading fragments) sink to the top.
    function reorderSections() {
        const units = collectUnits(content);
        const sorted = units
            .map(u => ({
                heading: u.heading,
                body: u.body,
                title: u.heading ? u.heading.textContent.trim() : ''
            }))
            .sort((a, b) => compareSectionTitles(a.title, b.title));

        units.forEach(u => {
            if (u.heading) u.heading.remove();
            u.body.forEach(el => el.remove());
        });

        const frag = document.createDocumentFragment();
        sorted.forEach(u => {
            if (u.heading) frag.appendChild(u.heading);
            u.body.forEach(el => frag.appendChild(el));
        });
        content.appendChild(frag);
    }

    // ------------------------------------------------------------------
    // Tag helpers
    // ------------------------------------------------------------------
    // "git, PYTHON, docker" -> ["git", "python", "docker"]  (# stripped)
    function parseTags(str) {
        return String(str || '')
            .split(/[\s,،]+/)
            .map(s => s.trim().replace(/^#+/, ''))
            .filter(Boolean);
    }

    function getUnitTags(unit) {
        if (!unit.heading) return [];
        const raw = unit.heading.getAttribute('data-tags') || '';
        return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase());
    }

    // The visible <span class="tag-chip"> elements belonging to a unit.
    function getTagElementsInUnit(unit) {
        const els = [];
        unit.body.forEach(el => {
            if (!el.classList) return;
            if (el.classList.contains('tag-chip')) {
                els.push(el);
            } else if (el.classList.contains('section-tags') || el.classList.contains('command-tags')) {
                els.push(...Array.from(el.querySelectorAll('.tag-chip')));
            }
        });
        return els;
    }

    // ------------------------------------------------------------------
    // Per-command tagging helpers
    // ------------------------------------------------------------------
    // Every command <pre> (rendered by renderSection) carries
    //   data-command-index  -> its position inside the section
    //   data-command-tags   -> its own comma-separated tags
    function collectCommandInfo(unit) {
        const out = [];
        unit.body.forEach(el => {
            if (el.tagName !== 'PRE') return;
            const idx = el.dataset && el.dataset.commandIndex;
            if (idx === undefined) return; // static commands have no per-command info
            out.push({
                idx: Number(idx),
                tags: (el.getAttribute('data-command-tags') || '')
                    .split(',').map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase())
            });
        });
        out.sort((a, b) => a.idx - b.idx);
        return out;
    }

    // The <span class="tag-chip"> elements shown under a specific command.
    function getCommandChipEls(unit, index) {
        for (const el of unit.body) {
            if (el.classList && el.classList.contains('command-tags')
                && Number(el.dataset.commandIndex) === index) {
                return Array.from(el.querySelectorAll('.tag-chip'));
            }
        }
        return [];
    }

    // Show/hide one specific command (<pre> + its tag chips).
    function setCommandVisible(unit, index, visible) {
        const display = visible ? '' : 'none';
        unit.body.forEach(el => {
            if (el.dataset && Number(el.dataset.commandIndex) === index) {
                el.style.display = display;
            }
        });
    }

    function setUnitVisible(unit, visible) {
        const display = visible ? '' : 'none';
        if (unit.heading) unit.heading.style.display = display;
        for (const el of unit.body) el.style.display = display;
    }

    // Is this element (or one of its ancestors up to #content) hidden by us?
    function isActuallyVisible(el) {
        let node = el;
        while (node && node !== content) {
            if (node.style && node.style.display === 'none') return false;
            node = node.parentElement;
        }
        return true;
    }

    function getVisibleCopyButtons() {
        return Array.from(content.querySelectorAll('.copy-btn')).filter(isActuallyVisible);
    }

    // ------------------------------------------------------------------
    // Match highlighting
    // ------------------------------------------------------------------
    function clearHighlights() {
        document.querySelectorAll('mark.search-hit').forEach(m => {
            const parent = m.parentNode;
            parent.replaceChild(document.createTextNode(m.textContent), m);
            parent.normalize();
        });
    }

    function highlightTextInElements(elements, term) {
        elements.forEach(root => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            while (walker.nextNode()) {
                const n = walker.currentNode;
                if (!n.nodeValue || n.nodeValue.trim() === '') continue;
                textNodes.push(n);
            }
            textNodes.forEach(node => {
                const lower = node.nodeValue.toLowerCase();
                let idx = lower.indexOf(term);
                if (idx === -1) return;
                const frag = document.createDocumentFragment();
                let last = 0;
                while (idx !== -1) {
                    if (idx > last) {
                        frag.appendChild(document.createTextNode(node.nodeValue.slice(last, idx)));
                    }
                    const mark = document.createElement('mark');
                    mark.className = 'search-hit';
                    mark.textContent = node.nodeValue.slice(idx, idx + term.length);
                    frag.appendChild(mark);
                    last = idx + term.length;
                    idx = lower.indexOf(term, last);
                }
                if (last < node.nodeValue.length) {
                    frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
                }
                node.parentNode.replaceChild(frag, node);
            });
        });
    }

    // ------------------------------------------------------------------
    // Filtering (smart search)
    //   - plain query  -> matched against section TITLES and CONTENT
    //   - query beginning with "#" -> matched against section TAGS
    //     * a section-level tag match shows the WHOLE section
    //     * otherwise individual commands that carry that tag are shown
    // ------------------------------------------------------------------
    function filterItems(query) {
        clearHighlights();
        const units = collectUnits(content);
        const q = (query || '').trim();
        const isTagSearch = q.startsWith('#');
        const term = (isTagSearch ? q.slice(1) : q).trim().toLowerCase();
        let visible = 0;

        if (term === '') {
            units.forEach(u => setUnitVisible(u, true));
            visible = units.length;
        } else {
            units.forEach(u => {
                let matches = false;
                if (isTagSearch) {
                    const sectionTagMatch = getUnitTags(u).some(t => t.includes(term));
                    if (sectionTagMatch) {
                        // The section itself is tagged -> show it completely.
                        matches = true;
                        setUnitVisible(u, true);
                        highlightTextInElements(getTagElementsInUnit(u), term);
                    } else {
                        // Filter the individual commands of this section.
                        // Start from everything hidden, then re-show the
                        // commands that carry the searched tag.
                        setUnitVisible(u, false);
                        const commands = collectCommandInfo(u);
                        let anyVisible = false;
                        commands.forEach(ci => {
                            const cmdMatch = ci.tags.some(t => t.includes(term));
                            if (cmdMatch) {
                                anyVisible = true;
                                setCommandVisible(u, ci.idx, true);
                                highlightTextInElements(getCommandChipEls(u, ci.idx), term);
                            }
                        });
                        // Keep the heading as a group label if any command matches.
                        if (u.heading) u.heading.style.display = anyVisible ? '' : 'none';
                        matches = anyVisible;
                    }
                } else {
                    // Plain search: match against the title OR the command/code
                    // content of the section. Highlight every occurrence.
                    const title = u.heading ? u.heading.textContent.toLowerCase() : '';
                    const contentText = u.body.map(el => el.textContent).join(' ').toLowerCase();
                    matches = title.includes(term) || contentText.includes(term);
                    if (matches) {
                        const targets = [];
                        if (u.heading) targets.push(u.heading);
                        targets.push(...u.body);
                        highlightTextInElements(targets, term);
                    }
                    setUnitVisible(u, matches);
                }
                if (matches) visible++;
            });
        }

        searchCount.textContent = `${visible} / ${units.length} sections`;
        console.log('filterItems', JSON.stringify(q), 'visible:', visible, 'of', units.length);
    }
    window.filterItems = filterItems; // expose for console tests

    // ------------------------------------------------------------------
    // Copy-button keyboard navigation
    // ------------------------------------------------------------------
    function focusFirstCopyButton() {
        const btns = getVisibleCopyButtons();
        if (btns.length > 0) btns[0].focus();
    }

    function moveCopyFocus(step) {
        const btns = getVisibleCopyButtons();
        if (btns.length === 0) return;
        const active = document.activeElement;
        const idx = btns.indexOf(active);
        if (idx === -1) {
            (step === 1 ? btns[0] : btns[btns.length - 1]).focus();
        } else {
            btns[(idx + step + btns.length) % btns.length].focus();
        }
    }

    function handleTab(shiftKey) {
        const btns = getVisibleCopyButtons();
        if (btns.length === 0) return; // never let Tab reach links / other elements
        const active = document.activeElement;
        const idx = btns.indexOf(active);

        if (shiftKey) {
            if (idx <= 0) {
                searchInput.focus(); // back to the search box
            } else {
                btns[idx - 1].focus();
            }
        } else {
            if (idx === -1) {
                btns[0].focus();
            } else {
                btns[(idx + 1) % btns.length].focus();
            }
        }
    }

    // ------------------------------------------------------------------
    // "Type anywhere" behaviour
    // ------------------------------------------------------------------
    function isTypingKey(e) {
        return !e.ctrlKey && !e.altKey && !e.metaKey
            && typeof e.key === 'string' && e.key.length === 1;
    }

    function isCompositionKey(e) {
        return e.isComposing || e.key === 'Process' || e.key === 'Dead';
    }

    function insertIntoSearch(char) {
        searchInput.focus();
        const start = searchInput.selectionStart ?? searchInput.value.length;
        const end = searchInput.selectionEnd ?? searchInput.value.length;
        searchInput.value = searchInput.value.slice(0, start) + char + searchInput.value.slice(end);
        const pos = start + char.length;
        searchInput.setSelectionRange(pos, pos);
        filterItems(searchInput.value);
    }

    function clearSearch() {
        searchInput.value = '';
        filterItems('');
        searchInput.focus();
    }

    // ------------------------------------------------------------------
    // Section management (add / edit / delete + persistence)
    // ------------------------------------------------------------------
    function slugify(text) {
        return String(text).toLowerCase()
            .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'section';
    }

    function assignSectionKeys() {
        const units = collectUnits(content);
        const seen = new Map();
        units.forEach(unit => {
            const headingText = unit.heading ? unit.heading.textContent.trim() : '(untitled)';
            const slug = slugify(headingText);
            const n = seen.get(slug) || 0;
            seen.set(slug, n + 1);
            const key = n === 0 ? `static-${slug}` : `static-${slug}-${n + 1}`;
            if (unit.heading) unit.heading.setAttribute('data-section-key', key);
            unit.body.forEach(el => el.setAttribute('data-section-key', key));
        });
    }

    function renderSection(key, title, commands, tags, commandTags) {
        const frag = document.createDocumentFragment();
        const h = document.createElement('h2');
        h.textContent = title;
        h.setAttribute('data-section-key', key);
        if (tags && tags.length) h.setAttribute('data-tags', tags.join(','));
        frag.appendChild(h);

        if (tags && tags.length) {
            const wrap = document.createElement('div');
            wrap.className = 'section-tags';
            wrap.setAttribute('data-section-key', key);
            tags.forEach(t => {
                const span = document.createElement('span');
                span.className = 'tag-chip';
                span.textContent = '#' + t;
                wrap.appendChild(span);
            });
            frag.appendChild(wrap);
        }

        (commands || []).forEach((cmd, i) => {
            const ctags = (commandTags || [])[i] || [];
            const pre = document.createElement('pre');
            pre.className = 'user-command';
            pre.setAttribute('data-section-key', key);
            pre.setAttribute('data-command-index', String(i));
            if (ctags.length) pre.setAttribute('data-command-tags', ctags.join(','));
            const code = document.createElement('code');
            code.textContent = cmd;
            pre.appendChild(code);
            frag.appendChild(pre);

            if (ctags.length) {
                const wrap = document.createElement('div');
                wrap.className = 'command-tags';
                wrap.setAttribute('data-section-key', key);
                wrap.setAttribute('data-command-index', String(i));
                ctags.forEach(t => {
                    const span = document.createElement('span');
                    span.className = 'tag-chip';
                    span.textContent = '#' + t;
                    wrap.appendChild(span);
                });
                frag.appendChild(wrap);
            }
        });
        return frag;
    }

    function replaceSectionDom(key, model) {
        const els = Array.from(content.querySelectorAll(`[data-section-key="${key}"]`));
        if (els.length === 0) return;
        const first = els[0];
        const frag = renderSection(key, model.title, model.commands, model.tags, model.commandTags);
        first.parentNode.insertBefore(frag, first);
        els.forEach(el => el.remove());
    }

    // localStorage with an in-memory fallback (e.g. file:// with blocked storage)
    let memoryStore = null;
    function getStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (err) {
            return memoryStore || (memoryStore = {});
        }
    }
    function saveStore(store) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (err) {
            memoryStore = store;
        }
    }

    function applyStoreToDom() {
        const store = getStore();
        const deleted = new Set(store.deleted || []);
        const edits = store.edits || {};
        const customKeys = new Set((store.custom || []).map(m => m.key));

        // Remove sections the user deleted (they still exist in the HTML file).
        content.querySelectorAll('[data-section-key]').forEach(el => {
            if (deleted.has(el.getAttribute('data-section-key'))) el.remove();
        });

        // Replace edited static sections (custom ones are handled below).
        Object.entries(edits).forEach(([key, model]) => {
            if (deleted.has(key) || customKeys.has(key)) return;
            replaceSectionDom(key, model);
        });

        // Append sections the user created, applying any edit for them.
        (store.custom || []).forEach(model => {
            if (deleted.has(model.key)) return;
            const finalModel = edits[model.key] || model;
            content.appendChild(
                renderSection(finalModel.key, finalModel.title, finalModel.commands, finalModel.tags, finalModel.commandTags)
            );
        });
    }

    function getSectionModel(key) {
        const els = Array.from(content.querySelectorAll(`[data-section-key="${key}"]`));
        let title = '';
        let tags = [];
        const commands = [];
        const commandTags = [];
        els.forEach(el => {
            if (HEADING_RE.test(el.tagName)) {
                title = el.textContent.trim();
                tags = parseTags(el.getAttribute('data-tags'));
                return;
            }
            if (el.tagName !== 'PRE') return;
            const code = el.querySelector('code');
            if (!code) return;
            commands.push(code.textContent.trim());
            commandTags.push(parseTags(el.getAttribute('data-command-tags')));
        });
        for (let i = commands.length - 1; i >= 0; i--) {
            if (!commands[i]) {
                commands.splice(i, 1);
                commandTags.splice(i, 1);
            }
        }
        return { key, title, tags, commands, commandTags };
    }

    function getActiveSectionKey() {
        const active = document.activeElement;
        if (!active || active === searchInput) return null;
        const el = active.closest('#content [data-section-key]');
        return el ? el.getAttribute('data-section-key') : null;
    }

    function highlightActiveSection() {
        content.querySelectorAll('.active-section').forEach(el => el.classList.remove('active-section'));
        const key = getActiveSectionKey();
        if (key) {
            content.querySelectorAll(`[data-section-key="${key}"]`).forEach(el => el.classList.add('active-section'));
        }
    }
    document.addEventListener('focusin', highlightActiveSection);

    // ------------------------------------------------------------------
    // Modal (add / edit section)
    // ------------------------------------------------------------------
    function openModal(mode, key) {
        modalMode = mode;
        modalKey = key || null;
        if (mode === 'edit' && key) {
            const model = getSectionModel(key);
            modalHeading.value = model.title;
            modalCommands.value = model.commands.join('\n');
            modalCommandTags.value = (model.commandTags || []).map(arr => arr.join(', ')).join('\n');
            modalTags.value = (model.tags || []).join(', ');
            modalTitleEl.textContent = 'Edit section';
            modalDelete.hidden = false;
        } else {
            modalHeading.value = '';
            modalCommands.value = '';
            modalCommandTags.value = '';
            modalTags.value = '';
            modalTitleEl.textContent = 'Add new section';
            modalDelete.hidden = true;
        }
        editorModal.classList.remove('hidden');
        modalHeading.focus();
    }

    function closeModal() {
        editorModal.classList.add('hidden');
        searchInput.focus();
    }

    function saveModal() {
        const title = modalHeading.value.trim();
        const commands = modalCommands.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const sectionTags = parseTags(modalTags.value);
        // One tags line per command line; lines beyond the command count are ignored.
        const rawCommandTags = modalCommandTags.value.split(/\r?\n/).map(ln => parseTags(ln));
        const commandTags = commands.map((cmd, i) => rawCommandTags[i] || []);
        if (!title) {
            modalHeading.focus();
            return;
        }
        const store = getStore();
        if (modalMode === 'edit' && modalKey) {
            // Edits to a user-created section update its own entry; edits to
            // a static section go into the edits override map.
            const custom = (store.custom || []).find(m => m.key === modalKey);
            if (custom) {
                custom.title = title;
                custom.commands = commands;
                custom.tags = sectionTags;
                custom.commandTags = commandTags;
            } else {
                store.edits = store.edits || {};
                store.edits[modalKey] = { title, commands, tags: sectionTags, commandTags };
            }
            replaceSectionDom(modalKey, { title, commands, tags: sectionTags, commandTags });
        } else {
            const key = `custom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            store.custom = store.custom || [];
            store.custom.push({ key, title, commands, tags: sectionTags, commandTags });
            content.appendChild(renderSection(key, title, commands, sectionTags, commandTags));
        }
        saveStore(store);
        reorderSections(); // keep everything in alphabetical order
        closeModal();
        ensureCopyButtons();
        filterItems(searchInput.value);
    }

    function deleteSection(key) {
        if (!key) return;
        const store = getStore();
        const isCustom = (store.custom || []).some(m => m.key === key);
        if (isCustom) {
            store.custom = store.custom.filter(m => m.key !== key);
        } else {
            store.deleted = store.deleted || [];
            if (!store.deleted.includes(key)) store.deleted.push(key);
            delete (store.edits || {})[key];
        }
        saveStore(store);
        content.querySelectorAll(`[data-section-key="${key}"]`).forEach(el => el.remove());
        ensureCopyButtons();
        filterItems(searchInput.value);
        searchInput.focus();
    }

    modalSave.addEventListener('click', saveModal);
    modalCancel.addEventListener('click', closeModal);
    modalClose.addEventListener('click', closeModal);
    modalDelete.addEventListener('click', () => {
        if (modalKey && confirm('Delete this section?')) {
            deleteSection(modalKey);
            closeModal();
        }
    });

    editorModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            saveModal();
            return;
        }
        if (e.key === 'Tab') {
            const focusables = Array.from(
                editorModal.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')
            ).filter(el => !el.hidden);
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (e.shiftKey) {
                if (active === first || !editorModal.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (active === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    // ------------------------------------------------------------------
    // Global key handling
    // ------------------------------------------------------------------
    document.addEventListener('keydown', (e) => {
        // While the modal is open, it handles its own keys.
        if (!editorModal.classList.contains('hidden')) return;

        const active = document.activeElement;

        // Typing a printable character (outside the search box) focuses the
        // search box and types there. Composition keys just move focus.
        if (active !== searchInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (isTypingKey(e)) {
                e.preventDefault();
                insertIntoSearch(e.key);
                return;
            }
            if (isCompositionKey(e)) {
                searchInput.focus();
                return;
            }
        }

        // Ctrl+I: add a new section.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            openModal('add');
            return;
        }

        // Ctrl+E: edit the section that contains the focused element.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'e' || e.key === 'E')) {
            e.preventDefault();
            const key = getActiveSectionKey();
            if (key) openModal('edit', key);
            return;
        }

        // Delete: remove the section that contains the focused element.
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const key = getActiveSectionKey();
            if (key) {
                e.preventDefault();
                if (confirm('Delete this section?')) deleteSection(key);
            }
            return;
        }

        // Tab / Shift+Tab cycles only through the visible copy buttons.
        if (e.key === 'Tab') {
            e.preventDefault();
            handleTab(e.shiftKey);
            return;
        }

        // ArrowUp / ArrowDown move between copy buttons once one is focused.
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp')
            && active && active.classList.contains('copy-btn')) {
            e.preventDefault();
            moveCopyFocus(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }

        // Escape: back to the search box, or clear it if already focused.
        if (e.key === 'Escape') {
            e.preventDefault();
            if (active === searchInput) {
                clearSearch();
            } else {
                searchInput.focus();
            }
            return;
        }
    });

    // Enter in the search box jumps to the first visible copy button.
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            focusFirstCopyButton();
        }
    });

    // Live filtering as the user types.
    searchInput.addEventListener('input', debounce((e) => {
        filterItems(e.target.value);
    }, 80));

    function debounce(fn, wait = 80) {
        let t = null;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    ensureCopyButtons();
    assignSectionKeys();
    applyStoreToDom();
    reorderSections(); // alphabetical first-pass sort
    ensureCopyButtons(); // for sections injected from the store
    filterItems('');
    searchInput.focus();
});
