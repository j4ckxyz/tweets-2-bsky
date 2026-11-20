import axios from 'axios';
import { useState } from 'react';
import { getApiErrorMessage } from '../lib/format';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';

// Login and first-user registration submit handlers.
export function useAuthForms(
  deps: Pick<
    ReturnType<typeof useDashboardState> & ReturnType<typeof useNotice> & ReturnType<typeof useAuthSession>,
    'fetchBootstrapStatus' | 'setAuthView' | 'setToken' | 'showNotice'
  >,
) {
  const { fetchBootstrapStatus, setAuthView, setToken, showNotice } = deps;

  const [isBusy, setIsBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setIsBusy(true);

    const data = new FormData(event.currentTarget);
    const identifier = String(data.get('identifier') || '').trim();
    const password = String(data.get('password') || '');

    try {
      const response = await axios.post<{ token: string }>('/api/login', { identifier, password });
      localStorage.setItem('token', response.data.token);
      setToken(response.data.token);
      showNotice('success', 'Logged in.');
    } catch (error) {
      setAuthError(getApiErrorMessage(error, 'Invalid credentials.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setIsBusy(true);

    const data = new FormData(event.currentTarget);
    const username = String(data.get('username') || '').trim();
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');

    try {
      await axios.post('/api/register', { username, email, password });
      setAuthView('login');
      showNotice('success', 'Registration successful. Please log in.');
      await fetchBootstrapStatus();
    } catch (error) {
      setAuthError(getApiErrorMessage(error, 'Registration failed.'));
    } finally {
      setIsBusy(false);
    }
  };

  return { isBusy, setIsBusy, authError, setAuthError, handleLogin, handleRegister };
}
