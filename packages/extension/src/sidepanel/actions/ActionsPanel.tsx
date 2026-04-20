// --- Priority 1: Captions + Actions ---
import React, { useEffect, useMemo, useState } from 'react';
import type { ActionItem } from '../../content/cognitive/action-items.js';
import './actions.css';

type FilterType = 'all' | 'high' | 'deadline' | 'email' | 'docs';

const FILTER_LABELS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High Priority' },
  { id: 'deadline', label: 'With Deadline' },
  { id: 'email', label: 'From Email' },
  { id: 'docs', label: 'From Docs' },
];

const PRIORITY_COLORS: Record<ActionItem['priority'], string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#10b981',
};

// Local Section wrapper matching sidepanel pattern
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-a11y-surface rounded-xl p-4" aria-label={title}>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-a11y-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}

// Group items by sourceUrl
function groupBySource(items: ActionItem[]): Map<string, ActionItem[]> {
  const groups = new Map<string, ActionItem[]>();
  for (const item of items) {
    const key = item.sourceUrl;
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

export default function ActionsPanel(): React.JSX.Element {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copyFlash, setCopyFlash] = useState<string | null>(null);

  // Load from storage on mount + listen for live updates
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get('actionItemsHistory').then((result) => {
        const history = result.actionItemsHistory as ActionItem[] | undefined;
        if (Array.isArray(history) && history.length > 0) {
          setItems(history);
        }
      }).catch(() => {});
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      const listener = (msg: { type: string; payload?: { items?: ActionItem[] } }) => {
        if (msg.type === 'ACTION_ITEMS_UPDATE' && Array.isArray(msg.payload?.items)) {
          setItems(msg.payload!.items!);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => {
        chrome.runtime.onMessage.removeListener(listener);
      };
    }

    return undefined;
  }, []);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (dismissed.has(item.id)) return false;
      switch (filter) {
        case 'all': return true;
        case 'high': return item.priority === 'high';
        case 'deadline': return item.dueDate !== null;
        case 'email': return item.sourceUrl.toLowerCase().includes('mail');
        case 'docs': return item.sourceUrl.toLowerCase().includes('docs') ||
                            item.sourceUrl.toLowerCase().includes('document');
        default: return true;
      }
    });
  }, [items, filter, dismissed]);

  const groupedItems = useMemo(() => groupBySource(filteredItems), [filteredItems]);

  const handleCopy = (item: ActionItem) => {
    navigator.clipboard.writeText(item.text).then(() => {
      setCopyFlash(item.id);
      setTimeout(() => setCopyFlash(null), 1500);
    }).catch(() => {});
  };

  const handleDismiss = (id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
  };

  return (
    <div className="space-y-3">
      <Section title="Action Items">
        {/* Filter pills */}
        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Filter action items">
          {FILTER_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`action-filter-pill${filter === id ? ' active' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Item list */}
        {filteredItems.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <div className="text-a11y-muted text-sm">No action items on this page yet.</div>
            <div className="text-a11y-muted text-xs leading-relaxed">
              Visit Gmail, Outlook, Google Docs, or any text-heavy page.
              TODOs, [ ], deadlines, and imperative sentences are auto-extracted.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {Array.from(groupedItems.entries()).map(([url, groupItems]) => {
              const title = groupItems[0]?.source ?? url;
              return (
                <div key={url}>
                  {/* Group header */}
                  <div className="text-a11y-muted text-xs mb-1.5 truncate" title={url}>
                    From: {title}
                  </div>
                  {/* Items in this group */}
                  <div className="space-y-1.5">
                    {groupItems.map((item) => (
                      <div
                        key={item.id}
                        className={`action-row flex items-start gap-2 bg-a11y-bg rounded-lg px-3 py-2${dismissed.has(item.id) ? ' dismissed' : ''}`}
                      >
                        {/* Priority dot */}
                        <div
                          className="action-priority-dot mt-1"
                          style={{ background: PRIORITY_COLORS[item.priority] }}
                          aria-label={`${item.priority} priority`}
                          title={`${item.priority} priority`}
                        />

                        {/* Text */}
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-xs text-a11y-text leading-relaxed truncate"
                            title={item.text}
                          >
                            {item.text}
                          </div>
                        </div>

                        {/* Right side: badge + actions */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {item.dueDate && (
                            <span className="action-due-badge" title={`Due: ${item.dueDate}`}>
                              {item.dueDate}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopy(item)}
                            className="text-xs px-1.5 py-0.5 rounded bg-a11y-surface text-a11y-muted hover:text-a11y-text transition-colors"
                            aria-label={`Copy: ${item.text}`}
                          >
                            {copyFlash === item.id ? (
                              <span className="action-copy-flash">Copied!</span>
                            ) : (
                              'Copy'
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDismiss(item.id)}
                            className="text-xs px-1.5 py-0.5 rounded bg-a11y-surface text-a11y-muted hover:text-red-400 transition-colors"
                            aria-label="Mark as done"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
