/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Aligned with landing-page brand palette (see UI_GUIDELINES.md §1).
        a11y: {
          bg: '#0a0a1a',
          'bg-alt': '#0d0d22',
          surface: '#1a1a2e',
          'surface-hover': '#222240',
          primary: '#7b68ee',
          accent: '#bb86fc',
          text: '#e2e8f0',
          muted: '#94a3b8',
          success: '#10b981',
          warning: '#f59e0b',
          danger: '#ef4444',
          focus: '#e94560', // coral — reserved for focus indicators only
        },
      },
    },
  },
  plugins: [],
};
