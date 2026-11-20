/** @type {import('tailwindcss').Config} */
const path = require('node:path');

const shades = (token) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      `oklch(var(${token}) / <alpha-value>)`,
    ]),
  );

module.exports = {
  darkMode: ['class'],
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        border: 'oklch(var(--border) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        rail: 'oklch(var(--rail) / <alpha-value>)',
        late: 'oklch(var(--late) / <alpha-value>)',
        slow: 'oklch(var(--slow) / <alpha-value>)',
        ok: 'oklch(var(--ok) / <alpha-value>)',
        info: 'oklch(var(--info) / <alpha-value>)',
        // Raw palette names used across the app resolve to the theme-aware
        // state tokens, so `text-red-600 dark:text-red-400` lands on the same
        // cancellation red in both themes instead of Tailwind's stock hues.
        red: shades('--late'),
        rose: shades('--late'),
        amber: shades('--slow'),
        yellow: shades('--slow'),
        orange: shades('--slow'),
        emerald: shades('--ok'),
        green: shades('--ok'),
        sky: shades('--info'),
        cyan: shades('--info'),
        blue: shades('--primary'),
        indigo: shades('--primary'),
      },
      borderRadius: {
        lg: '0.5rem',
        md: '0.375rem',
        sm: '0.25rem',
      },
      fontFamily: {
        sans: [
          '"Onest Variable"',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
