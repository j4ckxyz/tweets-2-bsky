import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { getMappingGroupMeta, normalizeTwitterUsername } from '../lib/format';
import { queryKeys } from '../lib/query-keys';
import type { EnrichedPost, LocalPostSearchResult } from '../lib/types';
import type { useAccountsList } from './useAccountsList';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Posts tab: folder filter and local post search.
export function usePosts(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useTheme> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useAuthForms> &
      ReturnType<typeof useGroups> &
      ReturnType<typeof useAccountsList>,
    | 'authHeaders'
    | 'groupOptions'
    | 'mappingsByBskyIdentifier'
    | 'enrichedPosts'
    | 'mappingsByTwitterUsername'
    | 'postsSearchQuery'
  >,
) {
  const {
    authHeaders,
    enrichedPosts,
    groupOptions,
    mappingsByBskyIdentifier,
    mappingsByTwitterUsername,
    postsSearchQuery,
  } = deps;

  const [postsGroupFilter, setPostsGroupFilter] = useState('all');
  const [activityGroupFilter, setActivityGroupFilter] = useState('all');
  const resolveMappingForLocalPost = useCallback(
    (post: LocalPostSearchResult) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  const resolveMappingForPost = useCallback(
    (post: EnrichedPost) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  // Filter the whole fetched feed, then keep the first 12: cutting to 12 first
  // left a folder empty whenever its posts were further down.
  const filteredPostedActivity = useMemo(
    () =>
      enrichedPosts
        .filter((post) => {
          if (postsGroupFilter === 'all') return true;
          const mapping = resolveMappingForPost(post);
          return getMappingGroupMeta(mapping).key === postsGroupFilter;
        })
        .slice(0, 12),
    [enrichedPosts, postsGroupFilter, resolveMappingForPost],
  );
  // Local post history search: debounced while typing; the previous results
  // stay on screen until the new ones arrive.
  const trimmedPostsSearchQuery = postsSearchQuery.trim();
  const [debouncedPostsSearchQuery, setDebouncedPostsSearchQuery] = useState(trimmedPostsSearchQuery);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedPostsSearchQuery(trimmedPostsSearchQuery), 220);
    return () => {
      window.clearTimeout(timer);
    };
  }, [trimmedPostsSearchQuery]);
  const localSearch = useQuery({
    queryKey: queryKeys.postSearch(debouncedPostsSearchQuery),
    queryFn: async () => {
      const response = await api.searchPosts({
        params: { q: debouncedPostsSearchQuery, limit: 120 },
        headers: authHeaders,
      });
      return Array.isArray(response.data) ? response.data : [];
    },
    enabled: Boolean(authHeaders) && debouncedPostsSearchQuery.length > 0,
    placeholderData: keepPreviousData,
    meta: { errorMessage: 'Failed to search local post history.' },
  });
  const searching = Boolean(authHeaders) && trimmedPostsSearchQuery.length > 0;
  const postSearchResults = localSearch.data;
  const localPostSearchResults = useMemo<LocalPostSearchResult[]>(
    () => (searching ? (postSearchResults ?? []) : []),
    [postSearchResults, searching],
  );
  const isSearchingLocalPosts =
    searching && (debouncedPostsSearchQuery !== trimmedPostsSearchQuery || localSearch.isFetching);

  const filteredLocalPostSearchResults = useMemo(
    () =>
      localPostSearchResults.filter((post) => {
        if (postsGroupFilter === 'all') return true;
        const mapping = resolveMappingForLocalPost(post);
        return getMappingGroupMeta(mapping).key === postsGroupFilter;
      }),
    [localPostSearchResults, postsGroupFilter, resolveMappingForLocalPost],
  );

  useEffect(() => {
    if (postsGroupFilter !== 'all' && !groupOptions.some((group) => group.key === postsGroupFilter)) {
      setPostsGroupFilter('all');
    }
    if (activityGroupFilter !== 'all' && !groupOptions.some((group) => group.key === activityGroupFilter)) {
      setActivityGroupFilter('all');
    }
  }, [activityGroupFilter, groupOptions, postsGroupFilter]);

  return {
    postsGroupFilter,
    setPostsGroupFilter,
    activityGroupFilter,
    setActivityGroupFilter,
    resolveMappingForLocalPost,
    resolveMappingForPost,
    filteredPostedActivity,
    filteredLocalPostSearchResults,
    localPostSearchResults,
    isSearchingLocalPosts,
  };
}
