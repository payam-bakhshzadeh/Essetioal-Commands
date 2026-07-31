// Robust Instant Search + copy-to-clipboard + keyboard navigation
console.log('script.js (robust) loading...');

const copyIcon = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
const checkIcon = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

// Run after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM ready — initializing instant search');

    // add copy buttons to all pre blocks
    document.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return; // avoid duplicates on re-init
        const code = pre.querySelector('code');
        if (!code) return;
        const rawText = code.innerText;
        const button = document.createElement('button');
        button.className = 'copy-btn';
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

    const terminal = document.getElementById('terminal-search');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');

    if (!terminal || !searchInput || !searchCount) {
        console.error('Required search elements not found', { terminal, searchInput, searchCount });
        return;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    // navLocked becomes true after pressing Enter (search box closes,
    // filter stays applied, focus moves to the first visible copy button).
    // While locked, ArrowUp / ArrowDown / Tab cycle only through the copy
    // buttons of the currently visible (filtered) items.
    let navLocked = false;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function getItems() {
        return Array.from(document.querySelectorAll('.search-item'));
    }

    function setItemVisible(item, visible) {
        item.style.display = visible ? '' : 'none';
    }

    function filterItems(query) {
        const items = getItems();
        const q = (query || '').toLowerCase().trim();
        let visibleCount = 0;
        if (q === '') {
            items.forEach(it => setItemVisible(it, true));
            searchCount.textContent = `${items.length} items found`;
            return;
        }
        items.forEach(it => {
            // innerText includes both the plain-text description AND the code
            // inside the <pre><code> blocks, so searching covers both.
            const text = it.innerText.toLowerCase();
            const matches = text.includes(q);
            setItemVisible(it, matches);
            if (matches) visibleCount++;
        });
        searchCount.textContent = `${visibleCount} items found`;
        console.log('filterItems', q, 'visible:', visibleCount);
    }

    window.filterItems = filterItems; // expose for console tests

    function getVisibleCopyButtons() {
        return getItems()
            .filter(it => it.style.display !== 'none')
            .map(it => it.querySelector('.copy-btn'))
            .filter(Boolean);
    }

    function openTerminal() {
        terminal.classList.remove('hidden');
        searchInput.value = '';
        filterItems('');
        navLocked = false; // leaving navigation mode when a new search begins
        setTimeout(() => searchInput.focus(), 0);
    }

    function closeTerminal({ clear = false } = {}) {
        terminal.classList.add('hidden');
        if (clear) {
            searchInput.value = '';
            filterItems('');
            navLocked = false;
        }
    }

    function debounce(fn, wait = 120) {
        let t = null;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // ------------------------------------------------------------------
    // Global key handling
    // ------------------------------------------------------------------
    document.addEventListener('keydown', (e) => {
        // ---- Ctrl + / toggles the terminal search bar ----
        const isSlash = (e.key === '/') || (e.code === 'Slash');
        const isModifier = e.ctrlKey || e.metaKey;
        if (isModifier && isSlash) {
            e.preventDefault();
            if (terminal.classList.contains('hidden')) openTerminal();
            else closeTerminal({ clear: false });
            return;
        }

        // ---- Escape closes the search bar and cancels filtering ----
        if (!terminal.classList.contains('hidden') && e.key === 'Escape') {
            e.preventDefault();
            closeTerminal({ clear: true });
            return;
        }

        // ---- Escape while navigating (after Enter) exits the locked state ----
        if (navLocked && e.key === 'Escape') {
            e.preventDefault();
            navLocked = false;
            filterItems('');
            console.log('Nav lock released, filter cleared');
            return;
        }

        // ---- Navigation mode (after Enter): arrows & Tab move between copy buttons ----
        if (navLocked && ['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) {
            const visibleCopyBtns = getVisibleCopyButtons();
            if (visibleCopyBtns.length === 0) return;
            const active = document.activeElement;
            const idx = visibleCopyBtns.indexOf(active);

            // Tab / Shift+Tab cycles only through the copy buttons while locked,
            // so focus never escapes the filtered results.
            if (e.key === 'Tab') {
                e.preventDefault();
                const step = e.shiftKey ? -1 : 1;
                if (idx === -1) {
                    e.shiftKey ? visibleCopyBtns[visibleCopyBtns.length - 1].focus() : visibleCopyBtns[0].focus();
                } else {
                    const next = (idx + step + visibleCopyBtns.length) % visibleCopyBtns.length;
                    visibleCopyBtns[next].focus();
                }
                return;
            }

            // ArrowDown / ArrowUp
            if (idx === -1) {
                e.preventDefault();
                visibleCopyBtns[0].focus();
                return;
            }
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            const next = (idx + step + visibleCopyBtns.length) % visibleCopyBtns.length;
            visibleCopyBtns[next].focus();
        }
    });

    // ------------------------------------------------------------------
    // Search input events
    // ------------------------------------------------------------------
    searchInput.addEventListener('input', debounce((e) => {
        filterItems(e.target.value);
    }, 100));

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const visibleCopyBtns = getVisibleCopyButtons();
            if (visibleCopyBtns.length > 0) {
                // Keep the filtered state, close the bar, focus the first result.
                navLocked = true;
                closeTerminal({ clear: false });
                visibleCopyBtns[0].focus();
            } else {
                // No matches — just close the bar and show everything again.
                closeTerminal({ clear: true });
            }
        }
    });

    // initial count
    filterItems('');
});