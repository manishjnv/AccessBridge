import React from 'react';

interface Tab {
  id: string;
  label: string;
}

interface TabNavProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

export function TabNav({ tabs, active, onChange }: TabNavProps) {
  return (
    <nav className="flex bg-a11y-surface/50 border-b border-a11y-primary/20 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`
            flex-1 text-xs py-2 px-1 text-center whitespace-nowrap transition-colors
            ${
              active === tab.id
                ? 'text-a11y-accent border-b-2 border-a11y-accent font-semibold'
                : 'text-a11y-muted hover:text-a11y-text'
            }
          `}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
