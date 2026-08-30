// Keyboard-first live search for a command reference with block comments.
//
// - One search box; typing anywhere focuses it. Clicking a copy button puts
//   focus straight back into the search box so the user can keep typing or
//   press Backspace without touching the mouse.
// - Each title is ONE code block (.code-block). Every command inside it is a
//   .cmd-row with its own copy button and its own numeric id badge (1, 2, 3...)
//   that is global across all sections and re-numbered from 1 on every re-sort.
// - To edit a command by id, type ":N" in the search box and press Ctrl+E
//   (":N" is an explicit id query, so it never collides with text like "a= 10";
//   a plain number that doesn't match any text also works). Enter jumps to it.
// - Comments use '# ' syntax (trailing or full-line). Copy only ever includes
//   the raw commands - comments are stripped and whole comment lines dropped.
// - In the editor, one Enter continues the same command; a blank line (two
//   Enters) or Shift+Enter starts a new independent command.
// - Tab / arrows move between copy buttons, Enter copies the focused button.
// - Ctrl+I adds a section; Ctrl+E edits the focused command row (or the whole
//   section when a heading is focused) or the row whose id is typed in search.
// - Custom sections and edits are persisted in localStorage.
console.log('script.js (keyboard-first search + command blocks) loading...');

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
// Shift+Enter inside the editor inserts this separator. It is an actual line
// separator, so it renders like a newline in a <textarea> while still being
// distinct from a plain one-Enter line continuation.
const BLOCK_SEP = '\u2028';

// ------------------------------------------------------------------------
// Comment-aware helpers
// ------------------------------------------------------------------------
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// A comment starts at a '#' at the start of a line or right after whitespace,
// and is followed by whitespace, another '#' or the end of the line.
function findCommentStart(line) {
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== '#') continue;
        const prev = i === 0 ? '' : line[i - 1];
        const next = i + 1 < line.length ? line[i + 1] : '';
        if ((i === 0 || /\s/.test(prev)) && (next === '' || next === '#' || /\s/.test(next))) {
            return i;
        }
    }
    return -1;
}

// Build the innerHTML of .cmd-lines from the raw command text: one .ln span
// per physical line; a full-line comment gets .comment-line (extra spacing);
// the comment part of any line is wrapped in <span class="comment">.
function buildCommandHtml(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => {
            const idx = findCommentStart(line);
            if (idx === -1) return `<span class="ln">${escapeHtml(line)}</span>`;
            const cmd = line.slice(0, idx);
            if (cmd.trim() === '') {
                return `<span class="ln comment-line"><span class="comment">${escapeHtml(line)}</span></span>`;
            }
            return `<span class="ln">${escapeHtml(cmd)}<span class="comment">${escapeHtml(line.slice(idx))}</span></span>`;
        })
        .join('\n');
}

// The exact text copied for one .cmd-row: comments stripped, whole comment
// lines dropped, remaining physical lines joined with a newline.
function getRowCommandText(row) {
    const lines = Array.from(row.querySelectorAll('.ln'));
    const out = [];
    lines.forEach(ln => {
        const clone = ln.cloneNode(true);
        clone.querySelectorAll('.comment').forEach(el => el.remove());
        const text = clone.textContent.replace(/\s+$/, '');
        if (text.trim() === '') return;
        out.push(text);
    });
    return out.join('\n');
}

// Clipboard write with a legacy fallback for file:// and blocked APIs.
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (err) {
        console.warn('clipboard API blocked, using legacy fallback', err);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { if (document.execCommand) document.execCommand('copy'); } catch (e) { /* noop */ }
    ta.remove();
}

// Editor text -> independent commands. One Enter continues a command; a blank
// line (two Enter presses) or the Shift+Enter separator starts a new one.
function parseBlocks(value) {
    return String(value || '')
        .split(BLOCK_SEP)
        .flatMap(part => part.split(/\r?\n[ \t\r\n]*\r?\n/))
        .map(block => block.trim())
        .filter(Boolean);
}

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

    if (!content || !searchInput || !searchCount || !editorModal ||
        !modalHeading || !modalCommands || !modalSave || !modalDelete) {
        console.error('Required elements not found', { content, searchInput, searchCount, editorModal });
        return;
    }

    let modalMode = 'add';
    let modalKey = null;
    let modalBlockIndex = null;

    // ------------------------------------------------------------------
    // Copy buttons + command id badges (one set per command row)
    // ------------------------------------------------------------------
    function attachCopyButton(row) {
        let btn = row.querySelector('.copy-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.type = 'button';
            btn.innerHTML = copyIcon;
            btn.setAttribute('tabindex', '0');
            btn.setAttribute('aria-label', 'Copy command to clipboard');
            row.appendChild(btn);
        }
        // onclick (property) so re-inits never stack listeners.
        btn.onclick = async (e) => {
            e.preventDefault();
            await copyText(getRowCommandText(row));
            btn.innerHTML = checkIcon;
            btn.classList.add('copied');
            setTimeout(() => {
                btn.innerHTML = copyIcon;
                btn.classList.remove('copied');
            }, 1600);
            // بدون نیاز به کلیک موس، فوکوس به جستجو برمی‌گردد تا بتوان
            // بلافاصله تایپ کرد یا Backspace زد.
            searchInput.focus();
        };
    }

    function ensureCopyButtons(root = content) {
        root.querySelectorAll('.cmd-row').forEach(attachCopyButton);
    }

    function ensureCommandIdBadges(root = content) {
        root.querySelectorAll('.cmd-row').forEach(row => {
            if (row.querySelector('.cmd-id')) return;
            const chip = document.createElement('span');
            chip.className = 'cmd-id';
            row.insertBefore(chip, row.firstChild);
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
    // Section discovery (generic)
    // ------------------------------------------------------------------
    // Text of a body element excluding its id badge / copy button, so numeric
    // ids never leak into (and pollute) text searches or id disambiguation.
    function codeBlockText(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.cmd-id, .copy-btn').forEach(n => n.remove());
        return (clone.textContent || '').replace(/\s+/g, ' ').toLowerCase();
    }

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
            // .code-block is the atomic body element of a section.
            if (el.classList && el.classList.contains('code-block')) {
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
    // Alphabetical sorting (sections stay ordered by title)
    // ------------------------------------------------------------------
    function compareSectionTitles(a, b) {
        return String(a).localeCompare(String(b), undefined, {
            sensitivity: 'base',
            numeric: true
        });
    }

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

    // ------------------------------------------------------------------
    // Command ids: a global sequential counter, reset from 1 every time the
    // content is re-sorted, so deleted numbers are reused and the visible
    // order always matches id order (first row = id 1). No title prefix.
    // ------------------------------------------------------------------
    function assignCommandIds() {
        const units = collectUnits(content);
        let i = 1;
        units.forEach(unit => {
            unit.body.forEach(el => {
                if (!el.classList || !el.classList.contains('code-block')) return;
                el.querySelectorAll('.cmd-row').forEach(row => {
                    const id = String(i);
                    row.setAttribute('data-command-id', id);
                    row.id = `cmd-${id}`;
                    const chip = row.querySelector('.cmd-id');
                    if (chip) chip.textContent = id;
                    i++;
                });
            });
        });
    }

    // Resolve a command-id query from the search box. An id can be written
    // with a leading ':' (e.g. ":10") to tell it apart from a plain text
    // search (e.g. "10" matching "a= 10"); a plain number that isn't a live
    // text match can still be used by the Ctrl+E / Enter handlers.
    function parseIdQuery(value) {
        const q = String(value || '').trim();
        if (!q) return null;
        const m = /^:(\d+)$/.exec(q);
        return m ? m[1] : null;
    }

    function getBlockById(value) {
        const id = parseIdQuery(value);
        if (!id) return null;
        return content.querySelector(`.cmd-row[data-command-id="${id}"]`);
    }

    // Plain numbers: only treat them as command ids when they are candidates
    // AND the query does not match any visible content text (otherwise "10"
    // is a text search for "a= 10"). The exact/named ids are handled by
    // getBlockById via the ":" prefix, so here we intentionally match a row
    // whose numeric id is NOT already present in the text.
    function findRowForStat(value) {
        const q = String(value || '').trim();
        if (!/^\d+$/.test(q)) return null;
        const row = content.querySelector(`.cmd-row[data-command-id="${q}"]`);
        if (!row) return null;
        // If this same number appears in any visible content text (badges
        // excluded), treat it as a text search, not an id.
        const units = collectUnits(content)
            .filter(u => isActuallyVisible(u.heading) || u.body.some(el => isActuallyVisible(el)));
        const textBlob = units.map(u => u.body.map(codeBlockText).join(' ')).join(' ').toLowerCase();
        if (textBlob.includes(q)) return null;
        return row;
    }

    // Ctrl+E support for typing a plain id without the ':' prefix: resolve,
    // but only when the number is not also live matching text.
    function resolveIdForEdit(value) {
        const byPrefix = getBlockById(value);
        if (byPrefix) return byPrefix;
        return findRowForStat(value);
    }

    // ------------------------------------------------------------------
    // Rendering & normalisation
    // ------------------------------------------------------------------
    function normalizeCodeBlocks(root = content) {
        root.querySelectorAll('.cmd-row').forEach(row => {
            const lines = row.querySelector('.cmd-lines');
            if (lines) lines.innerHTML = buildCommandHtml(lines.textContent);
        });
    }

    // Converts any legacy <pre> blocks into the .code-block/.cmd-row layout.
    function migrateLegacyPres() {
        const pres = Array.from(content.querySelectorAll('pre'));
        if (pres.length === 0) return;
        pres.forEach(pre => {
            const code = pre.querySelector('code');
            const text = code ? code.textContent : pre.textContent;
            const key = pre.getAttribute('data-section-key');
            const block = document.createElement('div');
            block.className = 'code-block';
            const row = document.createElement('div');
            row.className = 'cmd-row';
            const lines = document.createElement('span');
            lines.className = 'cmd-lines';
            lines.textContent = text;
            row.appendChild(lines);
            block.appendChild(row);
            if (key) {
                block.setAttribute('data-section-key', key);
                row.setAttribute('data-section-key', key);
            }
            pre.replaceWith(block);
        });
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
    // Filtering (smart search): matches titles, commands AND comments
    // ------------------------------------------------------------------
    function filterItems(query) {
        clearHighlights();
        // clear any previous id-target highlight
        content.querySelectorAll('.cmd-row.id-target-highlight').forEach(r => r.classList.remove('id-target-highlight'));
        const units = collectUnits(content);
        const q = (query || '').trim();

        // Live id-search mode. ":" alone keeps EVERYTHING visible (nothing is
        // hidden, since ':' isn't inside any text). As soon as digits follow
        // (":145") only the sections that contain a matching id stay visible
        // and every matching row is highlighted, so the user can confirm the
        // exact command before pressing Ctrl+E or Enter.
        if (q.startsWith(':')) {
            const rest = q.slice(1).trim();
            if (rest === '') {
                units.forEach(u => setUnitVisible(u, true));
                searchCount.textContent = `${units.length} / ${units.length} sections`;
                console.log('filterItems (id mode, waiting for number)', JSON.stringify(q));
                return;
            }
            let visible = 0;
            let firstRow = null;
            units.forEach(u => {
                let unitMatch = false;
                u.body.forEach(el => {
                    if (!el.classList || !el.classList.contains('code-block')) return;
                    el.querySelectorAll('.cmd-row').forEach(row => {
                        const id = row.getAttribute('data-command-id') || '';
                        if (id.startsWith(rest)) {
                            unitMatch = true;
                            row.classList.add('id-target-highlight');
                            if (!firstRow) firstRow = row;
                        }
                    });
                });
                setUnitVisible(u, unitMatch);
                if (unitMatch) visible++;
            });
            searchCount.textContent = `${visible} / ${units.length} sections`;
            console.log('filterItems (id mode)', JSON.stringify(q), 'visible:', visible);
            if (firstRow) {
                try { firstRow.scrollIntoView({ block: 'nearest' }); } catch (err) { /* noop */ }
            }
            return;
        }

        const term = q.toLowerCase();
        let visible = 0;

        if (term === '') {
            units.forEach(u => setUnitVisible(u, true));
            visible = units.length;
        } else {
            units.forEach(u => {
                const title = u.heading ? u.heading.textContent.toLowerCase() : '';
                const contentText = u.body.map(codeBlockText).join(' ').toLowerCase();
                const matches = title.includes(term) || contentText.includes(term);
                if (matches) {
                    const targets = [];
                    if (u.heading) targets.push(u.heading);
                    targets.push(...u.body);
                    highlightTextInElements(targets, term);
                }
                setUnitVisible(u, matches);
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
        if (btns.length === 0) return;
        const active = document.activeElement;
        const idx = btns.indexOf(active);

        if (shiftKey) {
            if (idx <= 0) {
                searchInput.focus();
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

    // Modify the search box as if Backspace was pressed inside it, without
    // requiring the input itself to be focused.
    function backspaceInSearch() {
        const start = searchInput.selectionStart ?? searchInput.value.length;
        const end = searchInput.selectionEnd ?? searchInput.value.length;
        if (end > start) {
            searchInput.value = searchInput.value.slice(0, start) + searchInput.value.slice(end);
            searchInput.setSelectionRange(start, start);
        } else if (start > 0) {
            searchInput.value = searchInput.value.slice(0, start - 1) + searchInput.value.slice(start);
            searchInput.setSelectionRange(start - 1, start - 1);
        }
        filterItems(searchInput.value);
        searchInput.focus();
    }

    // ------------------------------------------------------------------
    // Section / command management (add / edit / delete + persistence)
    // ------------------------------------------------------------------
    // One <div class="code-block"> per section, each command its own row.
    function renderSection(key, title, blocks) {
        const frag = document.createDocumentFragment();
        const h = document.createElement('h2');
        h.textContent = title;
        h.setAttribute('data-section-key', key);
        frag.appendChild(h);

        const block = document.createElement('div');
        block.className = 'code-block';
        block.setAttribute('data-section-key', key);

        (blocks || []).forEach(command => {
            const row = document.createElement('div');
            row.className = 'cmd-row';
            row.setAttribute('data-section-key', key);

            const lines = document.createElement('span');
            lines.className = 'cmd-lines';
            lines.innerHTML = buildCommandHtml(command);

            row.appendChild(lines);
            attachCopyButton(row);
            block.appendChild(row);
        });

        frag.appendChild(block);
        return frag;
    }

    function replaceSectionDom(key, model) {
        const els = Array.from(content.querySelectorAll(`[data-section-key="${key}"]`));
        if (els.length === 0) return;
        const first = els[0];
        const frag = renderSection(key, model.title, model.commands);
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
                renderSection(finalModel.key, finalModel.title, finalModel.commands)
            );
        });
    }

    function getSectionModel(key) {
        const els = Array.from(content.querySelectorAll(`[data-section-key="${key}"]`));
        let title = '';
        const commands = [];
        els.forEach(el => {
            if (HEADING_RE.test(el.tagName)) {
                title = el.textContent.trim();
                return;
            }
            if (!el.classList || !el.classList.contains('code-block')) return;
            el.querySelectorAll('.cmd-row').forEach(row => {
                const lines = row.querySelector('.cmd-lines');
                if (lines) commands.push(lines.textContent.replace(/\s+$/, ''));
            });
        });
        return { key, title, commands };
    }

    function saveModel(key, model) {
        const store = getStore();
        const custom = (store.custom || []).find(m => m.key === key);
        if (custom) {
            custom.title = model.title;
            custom.commands = model.commands;
        } else {
            store.edits = store.edits || {};
            store.edits[key] = { title: model.title, commands: model.commands };
        }
        saveStore(store);
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

    function editBlockAt(row) {
        const blockEl = row ? row.closest('.code-block') : null;
        if (!blockEl) return;
        const key = blockEl.getAttribute('data-section-key');
        if (!key) return;
        const rows = Array.from(blockEl.querySelectorAll('.cmd-row'));
        const idx = rows.indexOf(row);
        if (idx === -1) return;
        openModal('editBlock', key, idx);
    }

    // ------------------------------------------------------------------
    // Modal (add section / edit section / edit one command row)
    // ------------------------------------------------------------------
    function openModal(mode, key, blockIndex) {
        modalMode = mode;
        modalKey = key || null;
        modalBlockIndex = (blockIndex === undefined || blockIndex === null) ? null : blockIndex;

        if (mode === 'editBlock' && key && modalBlockIndex !== null) {
            const model = getSectionModel(key);
            modalHeading.disabled = true;
            modalHeading.value = model.title;
            modalCommands.value = model.commands[modalBlockIndex] || '';
            modalTitleEl.textContent = 'Edit command';
            modalDelete.hidden = false;
            modalDelete.textContent = 'Delete command';
        } else {
            modalHeading.disabled = false;
            modalCommands.value = '';
            if (mode === 'edit' && key) {
                const model = getSectionModel(key);
                modalHeading.value = model.title;
                modalCommands.value = model.commands.join('\n\n');
                modalTitleEl.textContent = 'Edit section';
                modalDelete.hidden = false;
                modalDelete.textContent = 'Delete section';
            } else {
                modalHeading.value = '';
                modalTitleEl.textContent = 'Add new section';
                modalDelete.hidden = true;
            }
        }
        editorModal.classList.remove('hidden');
        if (mode === 'editBlock') modalCommands.focus();
        else modalHeading.focus();
    }

    function closeModal() {
        editorModal.classList.add('hidden');
        searchInput.focus();
    }

    function afterContentChange() {
        reorderSections();
        assignSectionKeys();
        ensureCopyButtons();
        ensureCommandIdBadges();
        normalizeCodeBlocks();
        assignCommandIds();
        filterItems(searchInput.value);
    }

    function saveModal() {
        const blocks = parseBlocks(modalCommands.value);
        if (modalMode === 'editBlock' && modalKey && modalBlockIndex !== null) {
            const model = getSectionModel(modalKey);
            if (model.commands.length === 0) return;
            if (blocks.length === 0) { closeModal(); return; }
            model.commands.splice(modalBlockIndex, 1, ...blocks);
            saveModel(modalKey, model);
            replaceSectionDom(modalKey, model);
        } else {
            const title = modalHeading.value.trim();
            if (!title) {
                modalHeading.focus();
                return;
            }
            if (modalMode === 'edit' && modalKey) {
                saveModel(modalKey, { title, commands: blocks });
                replaceSectionDom(modalKey, { title, commands: blocks });
            } else {
                const key = `custom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                const store = getStore();
                store.custom = store.custom || [];
                store.custom.push({ key, title, commands: blocks });
                saveStore(store);
                content.appendChild(renderSection(key, title, blocks));
            }
        }
        afterContentChange();
        closeModal();
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
        afterContentChange();
        searchInput.focus();
    }

    modalSave.addEventListener('click', saveModal);
    modalCancel.addEventListener('click', closeModal);
    modalClose.addEventListener('click', closeModal);

    modalDelete.addEventListener('click', () => {
        if (modalMode === 'editBlock' && modalKey && modalBlockIndex !== null) {
            if (!confirm('Delete this command?')) return;
            const model = getSectionModel(modalKey);
            model.commands.splice(modalBlockIndex, 1);
            if (model.commands.length === 0) {
                deleteSection(modalKey);
            } else {
                saveModel(modalKey, model);
                replaceSectionDom(modalKey, model);
                afterContentChange();
            }
            closeModal();
        } else if (modalKey && confirm('Delete this section?')) {
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
        if (e.target === modalCommands && e.key === 'Enter' && e.shiftKey) {
            // Shift+Enter => start a new independent command.
            e.preventDefault();
            const start = modalCommands.selectionStart ?? modalCommands.value.length;
            const end = modalCommands.selectionEnd ?? modalCommands.value.length;
            modalCommands.value =
                modalCommands.value.slice(0, start) + BLOCK_SEP + '\n' + modalCommands.value.slice(end);
            const pos = start + 1;
            modalCommands.setSelectionRange(pos, pos);
            return;
        }
        if (e.key === 'Tab') {
            const focusables = Array.from(
                editorModal.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')
            ).filter(el => !el.hidden && !el.disabled);
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

        // Backspace pressed anywhere outside the search box (e.g. after
        // clicking a copy button) deletes inside the search box instead.
        if (e.key === 'Backspace' && active !== searchInput) {
            e.preventDefault();
            backspaceInSearch();
            return;
        }

        // Ctrl+I: add a new section.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            openModal('add');
            return;
        }

        // Ctrl+E: edit the command row whose id is typed in the search box
        // (":10" or, when no text matches it, "10"), otherwise the row under
        // the focused copy button, and for a focused heading keep the whole
        // section edit.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'e' || e.key === 'E')) {
            e.preventDefault();
            const byId = getBlockById(searchInput.value);
            if (byId) { editBlockAt(byId); return; }
            const rowFromQuery = resolveIdForEdit(searchInput.value);
            if (rowFromQuery) { editBlockAt(rowFromQuery); return; }
            if (active && active !== searchInput) {
                const row = active.closest('#content .cmd-row');
                if (row) { editBlockAt(row); return; }
            }
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
            if (active === searchInput) clearSearch();
            else searchInput.focus();
            return;
        }
    });

    // Enter in the search box:
    //   ":N"               -> same action as Ctrl+E: open the editor for that id
    //   plain number/text  -> jump to that command's copy button (or the first
    //                         visible one), as before.
    searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const q = searchInput.value.trim();

        const idQuery = parseIdQuery(q);
        if (idQuery !== null) {
            const row = content.querySelector(`.cmd-row[data-command-id="${idQuery}"]`);
            if (row) editBlockAt(row);
            return;
        }

        const stat = findRowForStat(q);
        if (stat) {
            const btn = stat.querySelector('.copy-btn');
            if (btn) {
                try { btn.scrollIntoView({ block: 'nearest' }); } catch (err) { /* noop */ }
                btn.focus();
                return;
            }
        }
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
    assignSectionKeys();
    migrateLegacyPres();
    assignSectionKeys();       // re-tag after any legacy migration
    normalizeCodeBlocks();
    ensureCommandIdBadges();
    ensureCopyButtons();
    applyStoreToDom();
    afterContentChange();
    searchInput.focus();
});