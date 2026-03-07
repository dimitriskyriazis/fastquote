'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './CommandPalette.module.css';

type SearchResult = {
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
};

type GroupedResults = {
  offers: SearchResult[];
  customers: SearchResult[];
  contacts: SearchResult[];
  products: SearchResult[];
};

const EMPTY_RESULTS: GroupedResults = { offers: [], customers: [], contacts: [], products: [] };

const GROUPS: Array<{ key: keyof GroupedResults; label: string }> = [
  { key: 'offers', label: 'Offers' },
  { key: 'customers', label: 'Customers' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'products', label: 'Products' },
];

function flattenResults(results: GroupedResults): Array<SearchResult & { group: string }> {
  const flat: Array<SearchResult & { group: string }> = [];
  for (const { key, label } of GROUPS) {
    for (const item of results[key]) {
      flat.push({ ...item, group: label });
    }
  }
  return flat;
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GroupedResults>(EMPTY_RESULTS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const router = useRouter();

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setResults(EMPTY_RESULTS);
  }, []);

  // Global keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => {
          if (prev) return false;
          setQuery('');
          setResults(EMPTY_RESULTS);
          setActiveIndex(0);
          return true;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=5`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        if (data.ok) {
          setResults(data.results);
          setActiveIndex(0);
        }
      } catch {
        setResults(EMPTY_RESULTS);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const flat = flattenResults(results);
  const hasResults = flat.length > 0;

  const navigateTo = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(flat.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + flat.length) % Math.max(flat.length, 1));
    } else if (e.key === 'Enter' && flat[activeIndex]) {
      e.preventDefault();
      navigateTo(flat[activeIndex].href);
    }
  };

  if (!isOpen) return null;

  let currentGroup = '';

  return (
    <div className={styles.overlay} onClick={close} role="dialog" aria-modal="true" aria-label="Search">
      <div className={styles.palette} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.inputWrapper}>
          <svg className={styles.searchIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search offers, customers, contacts, products..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className={styles.closeButton} onClick={close} aria-label="Close search">&times;</button>
        </div>
        <div className={styles.results}>
          {query.trim().length < 2 ? (
            <div className={styles.empty}>Type at least 2 characters to search</div>
          ) : loading ? (
            <div className={styles.empty}>Searching...</div>
          ) : !hasResults ? (
            <div className={styles.empty}>No results found</div>
          ) : (
            flat.map((item, index) => {
              const showGroup = item.group !== currentGroup;
              currentGroup = item.group;
              return (
                <div key={`${item.group}-${item.id}`}>
                  {showGroup && <div className={styles.groupLabel}>{item.group}</div>}
                  <a
                    className={styles.resultItem}
                    data-active={index === activeIndex}
                    href={item.href}
                    onClick={(e) => {
                      e.preventDefault();
                      navigateTo(item.href);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span className={styles.resultLabel}>{item.label}</span>
                    {item.sublabel && <span className={styles.resultSublabel}>{item.sublabel}</span>}
                  </a>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
