const copyIcon = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
const checkIcon = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

// ۱. آماده‌سازی بلوک‌های کد و اضافه کردن دکمه کپی
document.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');

    if (code) {
        const rawText = code.innerText;
        const lines = code.innerHTML.split('\n');

        const highlightedLines = lines.map(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) {
                return `<span class="comment">${line}</span>`;
            }
            return line;
        });

        code.innerHTML = highlightedLines.join('\n');

        const button = document.createElement('button');
        button.className = 'copy-btn';
        button.innerHTML = copyIcon;
        button.setAttribute('tabindex', '0'); // قابلیت فوکوس با Tab

        button.addEventListener('click', () => {
            navigator.clipboard.writeText(rawText).then(() => {
                button.innerHTML = checkIcon;
                setTimeout(() => {
                    button.innerHTML = copyIcon;
                }, 2000);
            });
        });

        pre.appendChild(button);
    }
});

// ۲. مدیریت ترمینال جستجو و فیلتر لایو
const terminal = document.getElementById('terminal-search');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const items = document.querySelectorAll('.search-item');

function filterItems(query) {
    let visibleCount = 0;
    const cleanQuery = query.toLowerCase().trim();

    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        if (text.includes(cleanQuery)) {
            item.style.display = '';
            visibleCount++;
        } else {
            item.style.display = 'none';
        }
    });

    searchCount.textContent = `${visibleCount} items found`;
}

// نمایش/مخفی‌سازی ترمینال با Ctrl + /
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        if (terminal.classList.contains('hidden')) {
            terminal.classList.remove('hidden');
            searchInput.focus();
        } else {
            closeTerminal();
        }
    }

    if (e.key === 'Escape' && !terminal.classList.contains('hidden')) {
        closeTerminal();
    }
});

function closeTerminal() {
    terminal.classList.add('hidden');
}

// فیلتر لایو هنگام تایپ
searchInput.addEventListener('input', (e) => {
    filterItems(e.target.value);
});

// ۳. بستن ترمینال با کلید Enter و انتقال فوکوس روی اولین دکمه کپی
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        closeTerminal();

        // پیدا کردن دکمه‌های کپی مرتبط با آیتم‌های مرئی
        const visibleCopyBtns = Array.from(document.querySelectorAll('.search-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.querySelector('.copy-btn'))
            .filter(btn => btn !== null);

        if (visibleCopyBtns.length > 0) {
            visibleCopyBtns[0].focus();
        }
    }
});

// ۴. کلیدهای جهت‌نمای پایین و بالا برای پیمایش بین دکمه‌های کپی مرئی
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const visibleCopyBtns = Array.from(document.querySelectorAll('.search-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.querySelector('.copy-btn'))
            .filter(btn => btn !== null);

        const currentIndex = visibleCopyBtns.indexOf(document.activeElement);

        if (currentIndex !== -1) {
            e.preventDefault();
            if (e.key === 'ArrowDown') {
                const nextIndex = (currentIndex + 1) % visibleCopyBtns.length;
                visibleCopyBtns[nextIndex].focus();
            } else if (e.key === 'ArrowUp') {
                const prevIndex = (currentIndex - 1 + visibleCopyBtns.length) % visibleCopyBtns.length;
                visibleCopyBtns[prevIndex].focus();
            }
        }
    }
});