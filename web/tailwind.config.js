/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./conversation.html",
    "./memory.html",
    "./skills.html",
    "./settings.html",
    "./connections.html",
    "./health.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // F202608275380: 滚动上限 token
      maxHeight: {
        'modal-scroll': 'var(--modal-scroll-max-h)',
        'modal-content': 'var(--modal-content-max-h)',
        'section-scroll': 'var(--section-scroll-max-h)',
        'list-scroll': 'var(--list-scroll-max-h)',
        'compact-scroll': 'var(--compact-scroll-max-h)',
        'input-scroll': 'var(--input-scroll-max-h)',
        'preview-scroll': 'var(--preview-scroll-max-h)',
      },
      // F202608275380: 玻璃色/状态色/骨架色 token
      backgroundColor: {
        'glass-surface': 'var(--glass-surface)',
        'status-success': 'var(--status-success)',
        'status-error': 'var(--status-error)',
        'status-running': 'var(--status-running)',
        'status-stalled': 'var(--status-stalled)',
        'skeleton': 'var(--skeleton-bg)',
      },
    },
  },
  plugins: [],
}
