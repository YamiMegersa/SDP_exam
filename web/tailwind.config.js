/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces: obsidian -> regolith. Tokens follow the supplied design system.
        base: {
          950: '#0a0d14', // viewport / deep space void
          900: '#111827', // instrument chassis
          850: '#151d2b',
          800: '#1a2234', // elevated tray
          700: '#1f293d', // panel seam
          600: '#283548', // hover / strong seam
        },
        ink: {
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#94a3b8',
          400: '#64748b',
          500: '#475569',
        },
        // Functional status. Colour is never decorative: it means something.
        ok: '#10b981',
        warn: '#f59e0b',
        crit: '#ef4444',
        inhand: '#6366f1',
        inert: '#475569',
        // Service accents.
        rta: '#38bdf8',
        mhe: '#fb923c',
        opg: '#facc15',
        // Replay: the accent, plus the two violets the top bar shifts to (design system §7).
        replay: {
          DEFAULT: '#a855f7',
          900: '#581c87',
          950: '#2e1065',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Roboto Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // 10 px: status tags / badges (design system §3).
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        // 11 px: widget titles / labels. One pixel above the badge so rank reads as hierarchy.
        xs2: ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        alarm: '0 0 12px rgba(239, 68, 68, 0.5)',
        caution: '0 0 10px rgba(245, 158, 11, 0.45)',
        panel: '0 4px 6px -1px rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'sweep': 'sweep 2.4s linear infinite',
      },
    },
  },
  plugins: [],
};
