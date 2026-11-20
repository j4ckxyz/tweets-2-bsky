import { useCallback, useRef, useState } from 'react';
import { DEFAULT_GROUP_EMOJI, defaultUserForm } from '../lib/constants';
import type {
  AccountGroup,
  AccountMapping,
  AccountSecurityEmailState,
  AccountSecurityPasswordState,
  ActivityLog,
  AuthUser,
  AuthView,
  BlueskyCredentialValidation,
  BskyProfileView,
  EnrichedPost,
  FediverseBridgeStatusView,
  LocalPostSearchResult,
  ManagedUser,
  RuntimeVersionInfo,
  SettingsSection,
  StatusResponse,
  TwitterMirrorProfile,
  UpdateStatusInfo,
  UserFormState,
} from '../lib/types';

// State shared across areas: everything here is reset on sign-out (see handleLogout).
export function useDashboardState() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [authView, setAuthView] = useState<AuthView>('login');

  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [enrichedPosts, setEnrichedPosts] = useState<EnrichedPost[]>([]);
  const [profilesByActor, setProfilesByActor] = useState<Record<string, BskyProfileView>>({});
  const [recentActivity, setRecentActivity] = useState<ActivityLog[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersionInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo | null>(null);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [editingMapping, setEditingMapping] = useState<AccountMapping | null>(null);
  const [newTwitterUsers, setNewTwitterUsers] = useState<string[]>([]);
  const [newTwitterMirrorProfiles, setNewTwitterMirrorProfiles] = useState<Record<string, TwitterMirrorProfile>>({});
  const [selectedMirrorSourceUsername, setSelectedMirrorSourceUsername] = useState('');
  const [validatedBskyCredentials, setValidatedBskyCredentials] = useState<BlueskyCredentialValidation | null>(null);
  const [isMirrorPreviewLoading, setIsMirrorPreviewLoading] = useState(false);
  const [isCredentialValidationBusy, setIsCredentialValidationBusy] = useState(false);
  const [syncingProfileMappingId, setSyncingProfileMappingId] = useState<string | null>(null);
  const [isSyncAllProfilesBusy, setIsSyncAllProfilesBusy] = useState(false);
  const [bridgingMappingId, setBridgingMappingId] = useState<string | null>(null);
  const [isBridgeAllBusy, setIsBridgeAllBusy] = useState(false);
  const [bridgeAllProgress, setBridgeAllProgress] = useState<{
    currentHandle: string;
    completed: number;
    total: number;
  } | null>(null);
  const [fediverseBridgeStatusByMappingId, setFediverseBridgeStatusByMappingId] = useState<
    Record<string, FediverseBridgeStatusView>
  >({});
  const [editTwitterUsers, setEditTwitterUsers] = useState<string[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupEmoji, setNewGroupEmoji] = useState(DEFAULT_GROUP_EMOJI);
  const [isAddAccountSheetOpen, setIsAddAccountSheetOpen] = useState(false);
  const [addAccountStep, setAddAccountStep] = useState(1);
  const [settingsActiveSection, setSettingsActiveSection] = useState<SettingsSection>('account');
  const [accountsSearchQuery, setAccountsSearchQuery] = useState('');
  const [postsSearchQuery, setPostsSearchQuery] = useState('');
  const [localPostSearchResults, setLocalPostSearchResults] = useState<LocalPostSearchResult[]>([]);
  const [isSearchingLocalPosts, setIsSearchingLocalPosts] = useState(false);
  const [groupDraftsByKey, setGroupDraftsByKey] = useState<Record<string, { name: string; emoji: string }>>({});
  const [isGroupActionBusy, setIsGroupActionBusy] = useState(false);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [accountsCreatorFilter, setAccountsCreatorFilter] = useState('all');
  const [newUserForm, setNewUserForm] = useState<UserFormState>(defaultUserForm);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingUserForm, setEditingUserForm] = useState<UserFormState>(defaultUserForm);
  const [emailForm, setEmailForm] = useState<AccountSecurityEmailState>({
    currentEmail: '',
    newEmail: '',
    password: '',
  });
  const [passwordForm, setPasswordForm] = useState<AccountSecurityPasswordState>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [isUpdateBusy, setIsUpdateBusy] = useState(false);
  const postsSearchRequestRef = useRef(0);

  // Everything a signed-in session leaves behind, cleared on sign-out.
  const resetDashboardState = useCallback(() => {
    setToken(null);
    setMe(null);
    setMappings([]);
    setGroups([]);
    setEnrichedPosts([]);
    setProfilesByActor({});
    setStatus(null);
    setRuntimeVersion(null);
    setUpdateStatus(null);
    setRecentActivity([]);
    setEditingMapping(null);
    setNewTwitterUsers([]);
    setNewTwitterMirrorProfiles({});
    setSelectedMirrorSourceUsername('');
    setValidatedBskyCredentials(null);
    setIsMirrorPreviewLoading(false);
    setIsCredentialValidationBusy(false);
    setSyncingProfileMappingId(null);
    setIsSyncAllProfilesBusy(false);
    setBridgingMappingId(null);
    setIsBridgeAllBusy(false);
    setBridgeAllProgress(null);
    setFediverseBridgeStatusByMappingId({});
    setEditTwitterUsers([]);
    setNewGroupName('');
    setNewGroupEmoji(DEFAULT_GROUP_EMOJI);
    setIsAddAccountSheetOpen(false);
    setAddAccountStep(1);
    setSettingsActiveSection('account');
    setAccountsSearchQuery('');
    setPostsSearchQuery('');
    setLocalPostSearchResults([]);
    setIsSearchingLocalPosts(false);
    setGroupDraftsByKey({});
    setIsGroupActionBusy(false);
    setIsUpdateBusy(false);
    setManagedUsers([]);
    setAccountsCreatorFilter('all');
    setNewUserForm(defaultUserForm());
    setEditingUserId(null);
    setEditingUserForm(defaultUserForm());
    setEmailForm({ currentEmail: '', newEmail: '', password: '' });
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    postsSearchRequestRef.current = 0;
    setAuthView('login');
  }, []);

  return {
    resetDashboardState,
    token,
    setToken,
    authView,
    setAuthView,
    mappings,
    setMappings,
    groups,
    setGroups,
    enrichedPosts,
    setEnrichedPosts,
    profilesByActor,
    setProfilesByActor,
    recentActivity,
    setRecentActivity,
    status,
    setStatus,
    runtimeVersion,
    setRuntimeVersion,
    updateStatus,
    setUpdateStatus,
    me,
    setMe,
    editingMapping,
    setEditingMapping,
    newTwitterUsers,
    setNewTwitterUsers,
    newTwitterMirrorProfiles,
    setNewTwitterMirrorProfiles,
    selectedMirrorSourceUsername,
    setSelectedMirrorSourceUsername,
    validatedBskyCredentials,
    setValidatedBskyCredentials,
    isMirrorPreviewLoading,
    setIsMirrorPreviewLoading,
    isCredentialValidationBusy,
    setIsCredentialValidationBusy,
    syncingProfileMappingId,
    setSyncingProfileMappingId,
    isSyncAllProfilesBusy,
    setIsSyncAllProfilesBusy,
    bridgingMappingId,
    setBridgingMappingId,
    isBridgeAllBusy,
    setIsBridgeAllBusy,
    bridgeAllProgress,
    setBridgeAllProgress,
    fediverseBridgeStatusByMappingId,
    setFediverseBridgeStatusByMappingId,
    editTwitterUsers,
    setEditTwitterUsers,
    newGroupName,
    setNewGroupName,
    newGroupEmoji,
    setNewGroupEmoji,
    isAddAccountSheetOpen,
    setIsAddAccountSheetOpen,
    addAccountStep,
    setAddAccountStep,
    settingsActiveSection,
    setSettingsActiveSection,
    accountsSearchQuery,
    setAccountsSearchQuery,
    postsSearchQuery,
    setPostsSearchQuery,
    localPostSearchResults,
    setLocalPostSearchResults,
    isSearchingLocalPosts,
    setIsSearchingLocalPosts,
    groupDraftsByKey,
    setGroupDraftsByKey,
    isGroupActionBusy,
    setIsGroupActionBusy,
    managedUsers,
    setManagedUsers,
    accountsCreatorFilter,
    setAccountsCreatorFilter,
    newUserForm,
    setNewUserForm,
    editingUserId,
    setEditingUserId,
    editingUserForm,
    setEditingUserForm,
    emailForm,
    setEmailForm,
    passwordForm,
    setPasswordForm,
    isUpdateBusy,
    setIsUpdateBusy,
    postsSearchRequestRef,
  };
}
