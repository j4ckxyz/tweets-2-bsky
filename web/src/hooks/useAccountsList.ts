import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ACCOUNT_PAGE_SIZE_DEFAULT, ACCOUNT_SEARCH_MIN_SCORE, DEFAULT_GROUP_NAME } from '../lib/constants';
import { canBridgeToFediverse, getMappingGroupMeta, normalizeTwitterUsername } from '../lib/format';
import { normalizeSearchValue, scoreAccountMapping, tokenizeSearchValue } from '../lib/search';
import type { AccountMapping } from '../lib/types';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Accounts tab list state: search, folder and creator filters, paging and selection.
export function useAccountsList(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useTheme> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useAuthForms> &
      ReturnType<typeof useGroups>,
    | 'accountsCreatorFilter'
    | 'accountsSearchQuery'
    | 'bridgingMappingId'
    | 'canManageAllMappings'
    | 'canManageMapping'
    | 'canManageOwnMappings'
    | 'fediverseBridgeStatusByMappingId'
    | 'groupOptions'
    | 'isAdmin'
    | 'isBridgeAllBusy'
    | 'isSyncAllProfilesBusy'
    | 'managedUsers'
    | 'mappings'
    | 'me'
    | 'profilesByActor'
    | 'setAccountsCreatorFilter'
    | 'syncingProfileMappingId'
  >,
) {
  const {
    accountsCreatorFilter,
    accountsSearchQuery,
    bridgingMappingId,
    canManageAllMappings,
    canManageMapping,
    canManageOwnMappings,
    fediverseBridgeStatusByMappingId,
    groupOptions,
    isAdmin,
    isBridgeAllBusy,
    isSyncAllProfilesBusy,
    managedUsers,
    mappings,
    me,
    profilesByActor,
    setAccountsCreatorFilter,
    syncingProfileMappingId,
  } = deps;

  const [pullingBioMappingId, setPullingBioMappingId] = useState<string | null>(null);
  const [isPullBioAllBusy, setIsPullBioAllBusy] = useState(false);
  const [isBotLabelAllBusy, setIsBotLabelAllBusy] = useState(false);
  const [isAppendBotNameAllBusy, setIsAppendBotNameAllBusy] = useState(false);
  const [selectedFolderKey, setSelectedFolderKey] = useState('__all__');
  const [accountsPage, setAccountsPage] = useState(1);
  const [accountsPageSize, setAccountsPageSize] = useState(ACCOUNT_PAGE_SIZE_DEFAULT);
  const [selectedAccountMappingIds, setSelectedAccountMappingIds] = useState<string[]>([]);
  const [showAccountAvatars, setShowAccountAvatars] = useState(false);
  const [showAccountBios, setShowAccountBios] = useState(false);
  const accountMappingsForView = useMemo(() => {
    if (!isAdmin || accountsCreatorFilter === 'all') {
      return mappings;
    }
    return mappings.filter((mapping) => mapping.createdByUserId === accountsCreatorFilter);
  }, [accountsCreatorFilter, isAdmin, mappings]);
  const botLabeledMappingsForView = useMemo(
    () => accountMappingsForView.filter((mapping) => mapping.hasBotLabel === true),
    [accountMappingsForView],
  );
  const isAnyBulkAccountsActionBusy =
    isSyncAllProfilesBusy ||
    isPullBioAllBusy ||
    isBridgeAllBusy ||
    isBotLabelAllBusy ||
    isAppendBotNameAllBusy ||
    Boolean(syncingProfileMappingId) ||
    Boolean(pullingBioMappingId) ||
    Boolean(bridgingMappingId);
  const bridgedMappingsForView = useMemo(
    () =>
      [...accountMappingsForView]
        .filter((mapping) => fediverseBridgeStatusByMappingId[mapping.id]?.bridged === true)
        .sort((a, b) => a.bskyIdentifier.localeCompare(b.bskyIdentifier)),
    [accountMappingsForView, fediverseBridgeStatusByMappingId],
  );
  const bridgeEligibleUnbridgedMappings = useMemo(
    () =>
      accountMappingsForView
        .filter(
          (mapping) =>
            canManageAllMappings ||
            (canManageOwnMappings && (!mapping.createdByUserId || mapping.createdByUserId === me?.id)),
        )
        .filter((mapping) => {
          const bridgeStatus = fediverseBridgeStatusByMappingId[mapping.id];
          if (!bridgeStatus || bridgeStatus.error) {
            return false;
          }
          if (bridgeStatus.bridged === true) {
            return false;
          }
          const profile = profilesByActor[normalizeTwitterUsername(mapping.bskyIdentifier)];
          return canBridgeToFediverse(profile?.createdAt);
        }),
    [
      accountMappingsForView,
      canManageAllMappings,
      canManageOwnMappings,
      fediverseBridgeStatusByMappingId,
      me?.id,
      profilesByActor,
    ],
  );
  const groupedMappings = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; emoji: string; mappings: AccountMapping[] }>();
    for (const option of groupOptions) {
      groups.set(option.key, {
        ...option,
        mappings: [],
      });
    }
    for (const mapping of accountMappingsForView) {
      const group = getMappingGroupMeta(mapping);
      const existing = groups.get(group.key);
      if (!existing) {
        groups.set(group.key, { ...group, mappings: [mapping] });
        continue;
      }
      existing.mappings.push(mapping);
    }

    return [...groups.values()]
      .sort((a, b) => {
        const aUngrouped = a.name === DEFAULT_GROUP_NAME;
        const bUngrouped = b.name === DEFAULT_GROUP_NAME;
        if (aUngrouped && !bUngrouped) return 1;
        if (!aUngrouped && bUngrouped) return -1;
        return a.name.localeCompare(b.name);
      })
      .map((group) => ({
        ...group,
        mappings: [...group.mappings].sort((a, b) =>
          `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
            `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
          ),
        ),
      }));
  }, [accountMappingsForView, groupOptions]);
  // A selected folder that no longer exists (deleted, or renamed elsewhere)
  // falls back to All rather than showing an empty list.
  useEffect(() => {
    if (selectedFolderKey !== '__all__' && !groupedMappings.some((group) => group.key === selectedFolderKey)) {
      setSelectedFolderKey('__all__');
    }
  }, [groupedMappings, selectedFolderKey]);
  const deferredAccountsSearchQuery = useDeferredValue(accountsSearchQuery);
  const normalizedAccountsQuery = useMemo(
    () => normalizeSearchValue(deferredAccountsSearchQuery),
    [deferredAccountsSearchQuery],
  );
  const accountSearchTokens = useMemo(() => tokenizeSearchValue(normalizedAccountsQuery), [normalizedAccountsQuery]);
  const accountSearchScores = useMemo(() => {
    const scores = new Map<string, number>();
    if (!normalizedAccountsQuery) {
      return scores;
    }

    for (const mapping of accountMappingsForView) {
      scores.set(mapping.id, scoreAccountMapping(mapping, normalizedAccountsQuery, accountSearchTokens));
    }
    return scores;
  }, [accountMappingsForView, accountSearchTokens, normalizedAccountsQuery]);
  const filteredGroupedMappings = useMemo(() => {
    const hasQuery = normalizedAccountsQuery.length > 0;
    const sortByScore = (items: AccountMapping[]) => {
      if (!hasQuery) {
        return items;
      }
      return [...items].sort((a, b) => {
        const scoreDelta = (accountSearchScores.get(b.id) || 0) - (accountSearchScores.get(a.id) || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
          `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
        );
      });
    };

    const withSearch = groupedMappings
      .map((group) => {
        const mappingsForGroup = hasQuery
          ? group.mappings.filter((mapping) => (accountSearchScores.get(mapping.id) || 0) >= ACCOUNT_SEARCH_MIN_SCORE)
          : group.mappings;
        return {
          ...group,
          mappings: sortByScore(mappingsForGroup),
        };
      })
      .filter((group) => !hasQuery || group.mappings.length > 0);

    if (selectedFolderKey !== '__all__') {
      const match = withSearch.find((group) => group.key === selectedFolderKey);
      return match ? [match] : [];
    }

    const allMappings = sortByScore(
      hasQuery
        ? accountMappingsForView.filter(
            (mapping) => (accountSearchScores.get(mapping.id) || 0) >= ACCOUNT_SEARCH_MIN_SCORE,
          )
        : [...accountMappingsForView].sort((a, b) =>
            `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
              `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
            ),
          ),
    );

    return [
      {
        key: '__all__',
        name: hasQuery ? 'Search Results' : 'All Accounts',
        emoji: hasQuery ? '🔎' : '🌐',
        mappings: allMappings,
      },
    ];
  }, [accountMappingsForView, accountSearchScores, selectedFolderKey, groupedMappings, normalizedAccountsQuery]);
  const accountMatchesCount = useMemo(
    () => filteredGroupedMappings.reduce((total, group) => total + group.mappings.length, 0),
    [filteredGroupedMappings],
  );
  const paginatedMappings = useMemo(
    () => filteredGroupedMappings.flatMap((group) => group.mappings),
    [filteredGroupedMappings],
  );
  const accountsPageCount = useMemo(
    () => Math.max(1, Math.ceil(paginatedMappings.length / Math.max(1, accountsPageSize))),
    [accountsPageSize, paginatedMappings.length],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately resets pagination whenever a filter or the page size changes
  useEffect(() => {
    setAccountsPage(1);
  }, [accountsPageSize, accountsSearchQuery, selectedFolderKey, accountsCreatorFilter]);
  useEffect(() => {
    if (accountsPage > accountsPageCount) {
      setAccountsPage(accountsPageCount);
    }
  }, [accountsPage, accountsPageCount]);
  const pagedMappingIdSet = useMemo(() => {
    const safePageSize = Math.max(1, accountsPageSize);
    const start = Math.max(0, (accountsPage - 1) * safePageSize);
    const end = start + safePageSize;
    return new Set(paginatedMappings.slice(start, end).map((mapping) => mapping.id));
  }, [accountsPage, accountsPageSize, paginatedMappings]);
  const pagedGroupedMappings = useMemo(
    () =>
      filteredGroupedMappings
        .map((group) => ({
          ...group,
          mappings: group.mappings.filter((mapping) => pagedMappingIdSet.has(mapping.id)),
        }))
        .filter((group) => group.mappings.length > 0),
    [filteredGroupedMappings, pagedMappingIdSet],
  );
  const currentAccountsPageStart =
    accountMatchesCount === 0 ? 0 : (accountsPage - 1) * Math.max(1, accountsPageSize) + 1;
  const currentAccountsPageEnd =
    accountMatchesCount === 0 ? 0 : Math.min(accountMatchesCount, accountsPage * Math.max(1, accountsPageSize));
  const manageableAccountMappingsForView = useMemo(
    () => accountMappingsForView.filter((mapping) => canManageMapping(mapping)),
    [accountMappingsForView, canManageMapping],
  );
  const manageableMappingIdsForView = useMemo(
    () => new Set(manageableAccountMappingsForView.map((mapping) => mapping.id)),
    [manageableAccountMappingsForView],
  );
  const selectedAccountMappingIdSet = useMemo(() => new Set(selectedAccountMappingIds), [selectedAccountMappingIds]);
  const selectedManageableMappingsForView = useMemo(
    () => manageableAccountMappingsForView.filter((mapping) => selectedAccountMappingIdSet.has(mapping.id)),
    [manageableAccountMappingsForView, selectedAccountMappingIdSet],
  );
  const selectedManageableMappingsCount = selectedManageableMappingsForView.length;
  const filteredManageableMappingIds = useMemo(() => {
    const seen = new Set<string>();
    for (const group of pagedGroupedMappings) {
      for (const mapping of group.mappings) {
        if (seen.has(mapping.id) || !canManageMapping(mapping)) {
          continue;
        }
        seen.add(mapping.id);
      }
    }
    return [...seen];
  }, [canManageMapping, pagedGroupedMappings]);
  const allFilteredManageableSelected =
    filteredManageableMappingIds.length > 0 &&
    filteredManageableMappingIds.every((mappingId) => selectedAccountMappingIdSet.has(mappingId));
  useEffect(() => {
    setSelectedAccountMappingIds((previous) => {
      const next = previous.filter((mappingId) => manageableMappingIdsForView.has(mappingId));
      if (next.length === previous.length) {
        return previous;
      }
      return next;
    });
  }, [manageableMappingIdsForView]);
  // Owner/creator columns only earn their width when more than one person
  // manages mappings on this instance.
  const showOwnerColumns = isAdmin && managedUsers.length > 1;

  useEffect(() => {
    if (!isAdmin) {
      if (accountsCreatorFilter !== 'all') {
        setAccountsCreatorFilter('all');
      }
      return;
    }

    if (accountsCreatorFilter !== 'all' && !managedUsers.some((user) => user.id === accountsCreatorFilter)) {
      setAccountsCreatorFilter('all');
    }
  }, [accountsCreatorFilter, isAdmin, managedUsers, setAccountsCreatorFilter]);

  const toggleAccountMappingSelection = (mappingId: string, checked: boolean) => {
    setSelectedAccountMappingIds((previous) => {
      if (checked) {
        if (previous.includes(mappingId)) {
          return previous;
        }
        return [...previous, mappingId];
      }
      return previous.filter((id) => id !== mappingId);
    });
  };

  const toggleSelectAllFilteredManageable = (checked: boolean) => {
    setSelectedAccountMappingIds((previous) => {
      if (!checked) {
        return previous.filter((mappingId) => !filteredManageableMappingIds.includes(mappingId));
      }
      const seen = new Set(previous);
      for (const mappingId of filteredManageableMappingIds) {
        seen.add(mappingId);
      }
      return [...seen];
    });
  };

  const clearSelectedAccountMappings = () => {
    setSelectedAccountMappingIds([]);
  };

  return {
    showAccountAvatars,
    setShowAccountAvatars,
    showAccountBios,
    setShowAccountBios,
    pullingBioMappingId,
    setPullingBioMappingId,
    isPullBioAllBusy,
    setIsPullBioAllBusy,
    isBotLabelAllBusy,
    setIsBotLabelAllBusy,
    isAppendBotNameAllBusy,
    setIsAppendBotNameAllBusy,
    selectedFolderKey,
    setSelectedFolderKey,
    accountsPage,
    setAccountsPage,
    accountsPageSize,
    setAccountsPageSize,
    selectedAccountMappingIds,
    setSelectedAccountMappingIds,
    accountMappingsForView,
    botLabeledMappingsForView,
    isAnyBulkAccountsActionBusy,
    bridgedMappingsForView,
    bridgeEligibleUnbridgedMappings,
    groupedMappings,
    deferredAccountsSearchQuery,
    normalizedAccountsQuery,
    accountSearchTokens,
    accountSearchScores,
    filteredGroupedMappings,
    accountMatchesCount,
    paginatedMappings,
    accountsPageCount,
    pagedMappingIdSet,
    pagedGroupedMappings,
    currentAccountsPageStart,
    currentAccountsPageEnd,
    manageableAccountMappingsForView,
    manageableMappingIdsForView,
    selectedAccountMappingIdSet,
    selectedManageableMappingsForView,
    selectedManageableMappingsCount,
    filteredManageableMappingIds,
    allFilteredManageableSelected,
    showOwnerColumns,
    toggleAccountMappingSelection,
    toggleSelectAllFilteredManageable,
    clearSelectedAccountMappings,
  };
}
