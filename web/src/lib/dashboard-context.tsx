// Dashboard state and actions, composed from the domain hooks in web/src/hooks.
// The hooks run in a fixed order: each one only reads what earlier hooks return.
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useAccountActions } from '../hooks/useAccountActions';
import { useAccountsList } from '../hooks/useAccountsList';
import { useActivity } from '../hooks/useActivity';
import { useAddAccount } from '../hooks/useAddAccount';
import { useAuthForms } from '../hooks/useAuthForms';
import { useAuthSession } from '../hooks/useAuthSession';
import { useDashboardData } from '../hooks/useDashboardData';
import { useDashboardState } from '../hooks/useDashboardState';
import { useEditMapping } from '../hooks/useEditMapping';
import { useGroups } from '../hooks/useGroups';
import { useNotice } from '../hooks/useNotice';
import { usePosts } from '../hooks/usePosts';
import { useRouting } from '../hooks/useRouting';
import { useSettings } from '../hooks/useSettings';
import { useTheme } from '../hooks/useTheme';
import { useUserAdmin } from '../hooks/useUserAdmin';

function useDashboardController() {
  // Each step adds one area's state and actions to everything before it.
  const session = { ...useDashboardState(), ...useTheme(), ...useNotice() };
  const withAuth = { ...session, ...useAuthSession(session), ...useRouting() };
  const withData = { ...withAuth, ...useDashboardData(withAuth) };
  const withAuthForms = { ...withData, ...useAuthForms(withData) };
  const withGroups = { ...withAuthForms, ...useGroups(withAuthForms) };
  const withAccountsList = { ...withGroups, ...useAccountsList(withGroups) };
  const withPosts = { ...withAccountsList, ...usePosts(withAccountsList) };
  const withActivity = { ...withPosts, ...useActivity(withPosts) };
  const withAccountActions = { ...withActivity, ...useAccountActions(withActivity) };
  const withAddAccount = { ...withAccountActions, ...useAddAccount(withAccountActions) };
  const withEditMapping = { ...withAddAccount, ...useEditMapping(withAddAccount) };
  const withSettings = { ...withEditMapping, ...useSettings(withEditMapping) };
  return { ...withSettings, ...useUserAdmin(withSettings) };
}

export type DashboardContextValue = ReturnType<typeof useDashboardController>;

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const value = useDashboardController();
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext);
  if (!value) {
    throw new Error('useDashboard must be used inside DashboardProvider');
  }
  return value;
}
