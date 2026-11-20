import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notice } from '../lib/types';

// The transient notice banner shown under the page header.
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((tone: Notice['tone'], message: string) => {
    setNotice({ tone, message });
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
    }, 4200);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  return { notice, setNotice, noticeTimerRef, showNotice };
}
