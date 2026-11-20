import { ArrowUpRight, Heart, Loader2, MessageCircle, Quote, Repeat2, UserRound } from 'lucide-react';
import { FolderGlyph } from '../components/FolderGlyph';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { DebouncedInput } from '../components/ui/debounced-input';
import { Label } from '../components/ui/label';
import { selectClassName } from '../lib/constants';
import { useDashboard } from '../lib/dashboard-context';
import { buildFacetSegments, formatCompactNumber } from '../lib/facets';
import { folderText } from '../lib/folders';
import { getMappingGroupMeta, getTwitterPostUrl } from '../lib/format';
import { cn } from '../lib/utils';

export function PostsPage() {
  const {
    filteredLocalPostSearchResults,
    filteredPostedActivity,
    getProfileForActor,
    groupOptions,
    isSearchingLocalPosts,
    postsGroupFilter,
    postsSearchQuery,
    resolveMappingForLocalPost,
    resolveMappingForPost,
    setPostsGroupFilter,
    setPostsSearchQuery,
  } = useDashboard();
  return (
    <section className="space-y-6 animate-fade-in">
      <Card className="">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Already Posted</CardTitle>
              <CardDescription>
                Native-styled feed plus local SQLite search across all crossposted history.
              </CardDescription>
            </div>
            <div className="grid w-full gap-2 md:max-w-2xl md:grid-cols-[1fr_240px]">
              <div className="space-y-1">
                <Label htmlFor="posts-search">Search crossposted posts</Label>
                <div className="relative">
                  <DebouncedInput
                    id="posts-search"
                    value={postsSearchQuery}
                    onChange={setPostsSearchQuery}
                    placeholder="Search by text, @username, tweet id, or Bluesky handle"
                  />
                  {isSearchingLocalPosts ? (
                    <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="posts-group-filter">Filter group</Label>
                <select
                  id="posts-group-filter"
                  className={selectClassName}
                  value={postsGroupFilter}
                  onChange={(event) => setPostsGroupFilter(event.target.value)}
                >
                  <option value="all">All folders</option>
                  {groupOptions.map((group) => (
                    <option key={`posts-filter-${group.key}`} value={group.key}>
                      {folderText(group.emoji, group.name)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {postsSearchQuery.trim() ? (
            filteredLocalPostSearchResults.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                {isSearchingLocalPosts ? 'Searching local history...' : 'No local crossposted posts matched.'}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredLocalPostSearchResults.map((post) => {
                  const mapping = resolveMappingForLocalPost(post);
                  const groupMeta = getMappingGroupMeta(mapping);
                  const sourceTweetUrl = post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
                  const postUrl =
                    post.postUrl ||
                    (post.bskyUri
                      ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${
                          post.bskyUri.split('/').filter(Boolean).pop() || ''
                        }`
                      : undefined);

                  return (
                    <article
                      key={`${post.twitterId}-${post.bskyIdentifier}-${post.bskyCid || post.createdAt || 'result'}`}
                      className="min-w-0 rounded-lg border border-border/70 bg-background p-4"
                    >
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            @{post.bskyIdentifier}{' '}
                            <span className="text-muted-foreground">from @{post.twitterUsername}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {post.createdAt ? new Date(post.createdAt).toLocaleString() : 'Unknown time'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">
                            <FolderGlyph emoji={groupMeta.emoji} />
                            {groupMeta.name}
                          </Badge>
                          <Badge variant="secondary">Relevance {Math.round(post.score)}</Badge>
                        </div>
                      </div>
                      <p className="mb-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                        {post.tweetText || 'No local tweet text stored for this record.'}
                      </p>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">Tweet ID: {post.twitterId}</span>
                        {sourceTweetUrl ? (
                          <a
                            className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                            href={sourceTweetUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Source
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : null}
                        {postUrl ? (
                          <a
                            className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                            href={postUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Bluesky
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          ) : filteredPostedActivity.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
              No posted entries yet.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredPostedActivity.map((post, index) => {
                const postUrl =
                  post.postUrl ||
                  (post.bskyUri
                    ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${
                        post.bskyUri.split('/').filter(Boolean).pop() || ''
                      }`
                    : undefined);
                const sourceTweetUrl = post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
                const segments = buildFacetSegments(post.text, post.facets || []);
                const mapping = resolveMappingForPost(post);
                const groupMeta = getMappingGroupMeta(mapping);
                const statItems: Array<{
                  key: 'likes' | 'reposts' | 'replies' | 'quotes';
                  value: number;
                  icon: typeof Heart;
                }> = [
                  { key: 'likes', value: post.stats.likes, icon: Heart },
                  { key: 'reposts', value: post.stats.reposts, icon: Repeat2 },
                  { key: 'replies', value: post.stats.replies, icon: MessageCircle },
                  { key: 'quotes', value: post.stats.quotes, icon: Quote },
                ].filter((item) => item.value > 0) as Array<{
                  key: 'likes' | 'reposts' | 'replies' | 'quotes';
                  value: number;
                  icon: typeof Heart;
                }>;
                const authorAvatar = post.author.avatar || getProfileForActor(post.author.handle)?.avatar;
                const authorHandle = post.author.handle || post.bskyIdentifier;
                const authorName = post.author.displayName || authorHandle;

                return (
                  <article
                    key={post.bskyUri || `${post.bskyCid || 'post'}-${post.createdAt || index}`}
                    className="cv-auto min-w-0 rounded-lg border border-border bg-background p-4"
                  >
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {authorAvatar ? (
                          <img
                            className="h-9 w-9 shrink-0 rounded-full border border-border/70 object-cover"
                            src={authorAvatar}
                            alt={authorName}
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground">
                            <UserRound className="h-4 w-4" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{authorName}</p>
                          <p className="break-words text-xs text-muted-foreground">
                            @{authorHandle} • from @{post.twitterUsername}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          <FolderGlyph emoji={groupMeta.emoji} />
                          {groupMeta.name}
                        </Badge>
                        <Badge variant="success">Posted</Badge>
                      </div>
                    </div>

                    <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                      {segments.map((segment, segmentIndex) => {
                        if (segment.type === 'text') {
                          return <span key={`${post.bskyUri}-segment-${segmentIndex}`}>{segment.text}</span>;
                        }

                        const linkTone =
                          segment.type === 'mention'
                            ? 'text-cyan-600 hover:text-cyan-500 dark:text-cyan-300 dark:hover:text-cyan-200'
                            : segment.type === 'tag'
                              ? 'text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200'
                              : 'text-sky-600 hover:text-sky-500 dark:text-sky-300 dark:hover:text-sky-200';

                        return (
                          <a
                            key={`${post.bskyUri}-segment-${segmentIndex}`}
                            className={cn('hover:underline', linkTone)}
                            href={segment.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {segment.text}
                          </a>
                        );
                      })}
                    </p>

                    {post.media.length > 0 ? (
                      <div className="mb-3 space-y-2">
                        {post.media.map((media, mediaIndex) => {
                          if (media.type === 'image') {
                            const imageSrc = media.url || media.thumb;
                            if (!imageSrc) return null;
                            return (
                              <a
                                key={`${post.bskyUri}-media-${mediaIndex}`}
                                className="group block overflow-hidden rounded-lg border border-border/70 bg-muted"
                                href={imageSrc}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <img
                                  className="h-56 w-full object-cover"
                                  src={imageSrc}
                                  alt={media.alt || 'Bluesky media'}
                                  loading="lazy"
                                />
                              </a>
                            );
                          }

                          if (media.type === 'video') {
                            const videoHref = media.url || media.thumb;
                            return (
                              <div
                                key={`${post.bskyUri}-media-${mediaIndex}`}
                                className="group overflow-hidden rounded-lg border border-border/70 bg-muted"
                              >
                                {media.thumb ? (
                                  <img
                                    className="h-56 w-full object-cover"
                                    src={media.thumb}
                                    alt={media.alt || 'Video thumbnail'}
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
                                    Video attachment
                                  </div>
                                )}
                                {videoHref ? (
                                  <div className="border-t border-border/70 p-2 text-right">
                                    <a
                                      className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                                      href={videoHref}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Open video
                                      <ArrowUpRight className="ml-1 h-3 w-3" />
                                    </a>
                                  </div>
                                ) : null}
                              </div>
                            );
                          }

                          if (media.type === 'external') {
                            if (!media.url) return null;
                            return (
                              <a
                                key={`${post.bskyUri}-media-${mediaIndex}`}
                                className="group block overflow-hidden rounded-lg border border-border/70 bg-background transition-colors hover:bg-muted/60"
                                href={media.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {media.thumb ? (
                                  <img
                                    className="h-40 w-full object-cover"
                                    src={media.thumb}
                                    alt={media.title || media.url}
                                    loading="lazy"
                                  />
                                ) : null}
                                <div className="space-y-1 p-3">
                                  <p className="truncate text-sm font-medium">{media.title || media.url}</p>
                                  {media.description ? (
                                    <p className="max-h-10 overflow-hidden text-xs text-muted-foreground">
                                      {media.description}
                                    </p>
                                  ) : null}
                                </div>
                              </a>
                            );
                          }

                          return null;
                        })}
                      </div>
                    ) : null}

                    {statItems.length > 0 ? (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {statItems.map((stat) => {
                          const Icon = stat.icon;
                          return (
                            <span
                              key={`${post.bskyUri}-stat-${stat.key}`}
                              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted px-2 py-1 text-xs text-muted-foreground"
                            >
                              <Icon className="h-3.5 w-3.5" />
                              {formatCompactNumber(stat.value)}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{post.createdAt ? new Date(post.createdAt).toLocaleString() : 'Unknown time'}</span>
                      <div className="flex items-center gap-3">
                        {sourceTweetUrl ? (
                          <a
                            className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                            href={sourceTweetUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Source
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : null}
                        {postUrl ? (
                          <a
                            className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                            href={postUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Bluesky
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : (
                          <span>Missing URI</span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
