import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMappingGroupMeta, normalizeTwitterUsername } from '../lib/format';
import type { EnrichedPost, LocalPostSearchResult } from '../lib/types';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';

// Posts tab: folder filter and local post search.
export function usePosts(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useGroups>,
    | 'authHeaders'
    | 'groupOptions'
    | 'handleAuthFailure'
    | 'localPostSearchResults'
    | 'mappingsByBskyIdentifier'
    | 'mappingsByTwitterUsername'
    | 'postedActivity'
    | 'postsSearchQuery'
    | 'postsSearchRequestRef'
    | 'setIsSearchingLocalPosts'
    | 'setLocalPostSearchResults'
  >,
) {
  const {
    authHeaders,
    groupOptions,
    handleAuthFailure,
    localPostSearchResults,
    mappingsByBskyIdentifier,
    mappingsByTwitterUsername,
    postedActivity,
    postsSearchQuery,
    postsSearchRequestRef,
    setIsSearchingLocalPosts,
    setLocalPostSearchResults,
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
  const filteredPostedActivity = useMemo(
    () =>
      postedActivity.filter((post) => {
        if (postsGroupFilter === 'all') return true;
        const mapping = resolveMappingForPost(post);
        return getMappingGroupMeta(mapping).key === postsGroupFilter;
      }),
    [postedActivity, postsGroupFilter, resolveMappingForPost],
  );
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

  useEffect(() => {
    if (!authHeaders) {
      setIsSearchingLocalPosts(false);
      setLocalPostSearchResults([]);
      return;
    }

    const query = postsSearchQuery.trim();
    if (!query) {
      postsSearchRequestRef.current += 1;
      setIsSearchingLocalPosts(false);
      setLocalPostSearchResults([]);
      return;
    }

    const requestId = postsSearchRequestRef.current + 1;
    postsSearchRequestRef.current = requestId;
    setIsSearchingLocalPosts(true);

    const timer = window.setTimeout(async () => {
      try {
        const response = await axios.get<LocalPostSearchResult[]>('/api/posts/search', {
          params: { q: query, limit: 120 },
          headers: authHeaders,
        });
        if (postsSearchRequestRef.current !== requestId) {
          return;
        }
        setLocalPostSearchResults(Array.isArray(response.data) ? response.data : []);
      } catch (error) {
        if (postsSearchRequestRef.current !== requestId) {
          return;
        }
        setLocalPostSearchResults([]);
        handleAuthFailure(error, 'Failed to search local post history.');
      } finally {
        if (postsSearchRequestRef.current === requestId) {
          setIsSearchingLocalPosts(false);
        }
      }
    }, 220);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    authHeaders,
    handleAuthFailure,
    postsSearchQuery,
    postsSearchRequestRef,
    setIsSearchingLocalPosts,
    setLocalPostSearchResults,
  ]);

  return {
    postsGroupFilter,
    setPostsGroupFilter,
    activityGroupFilter,
    setActivityGroupFilter,
    resolveMappingForLocalPost,
    resolveMappingForPost,
    filteredPostedActivity,
    filteredLocalPostSearchResults,
  };
}
