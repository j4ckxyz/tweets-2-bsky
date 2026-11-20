import { useEffect, useState } from 'react';
import type { ThemeMode } from '../lib/types';

// Light/dark/system theme: persisted choice and the class on <html>.
export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode');
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    localStorage.setItem('theme-mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const next = themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode;
      setResolvedTheme(next);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(next);
    };

    applyTheme();
    media.addEventListener('change', applyTheme);

    return () => {
      media.removeEventListener('change', applyTheme);
    };
  }, [themeMode]);

  const themeLabel = themeMode === 'system' ? `Theme: system (${resolvedTheme})` : `Theme: ${themeMode}`;

  return { themeMode, setThemeMode, resolvedTheme, setResolvedTheme, themeLabel };
}
