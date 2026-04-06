import React from 'react';
import { createRoot } from 'react-dom/client';
import '../content/styles.css';

function SidePanel() {
  return (
    <div className="bg-a11y-bg text-a11y-text min-h-screen p-4">
      <h1 className="text-lg font-bold text-a11y-accent mb-4">AccessBridge Side Panel</h1>
      <p className="text-a11y-muted text-sm">
        Side panel view coming soon. This will provide an expanded interface for
        managing accessibility adaptations, viewing detailed struggle analytics,
        and configuring advanced settings.
      </p>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <SidePanel />
    </React.StrictMode>,
  );
}
