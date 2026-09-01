// Dry-run preview: what an account's recent tweets would look like once
// mirrored, composed by the real posting path with nothing uploaded and
// nothing recorded. Lets an account be inspected before it is added, instead
// of enabling it and watching what comes out.
import { Eye, Image as ImageIcon, Link2, MessageSquare, Quote, Video } from 'lucide-react';
import { useCallback, useState } from 'react';
import axios from 'axios';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface PreviewChunk {
  text: string;
  length: number;
}

interface PreviewTweet {
  twitterId: string;
  originalText: string;
  createdAt?: string;
  chunks: PreviewChunk[];
  images: number;
  video: boolean;
  quote: boolean;
  linkCard: boolean;
  isReply: boolean;
  skipped?: { stage: string; reason: string };
}

interface PreviewResult {
  twitterUsername: string;
  fetched: number;
  tweets: PreviewTweet[];
}

export function MirrorPreview({
  twitterUsername,
  mappingId,
  authHeaders,
  limit = 5,
}: {
  twitterUsername: string;
  mappingId?: string;
  authHeaders?: Record<string, string>;
  limit?: number;
}) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!authHeaders || !twitterUsername) return;
    setLoading(true);
    setError(null);
    try {
      const response = await axios.post<PreviewResult>(
        '/api/preview',
        { twitterUsername, mappingId, limit },
        { headers: authHeaders },
      );
      setResult(response.data);
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(message ?? 'Could not build a preview for this account.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders, twitterUsername, mappingId, limit]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Preview</p>
          <p className="text-xs text-muted-foreground">
            Composes the last {limit} tweets exactly as they would post. Nothing is posted or recorded.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void run()}
          disabled={loading || !twitterUsername || !authHeaders}
        >
          <Eye className="mr-2 h-4 w-4" />
          {loading ? 'Composing…' : result ? 'Refresh' : 'Preview'}
        </Button>
      </div>

      {error ? <p className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">{error}</p> : null}

      {result && result.tweets.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          No recent tweets found for @{result.twitterUsername}.
        </p>
      ) : null}

      {result?.tweets.map((tweet) => (
        <div key={tweet.twitterId} className="cv-auto rounded-lg border border-border bg-background p-3">
          {tweet.skipped ? (
            <div className="text-sm">
              <Badge variant="secondary">skipped at {tweet.skipped.stage}</Badge>
              <p className="mt-2 text-muted-foreground">{tweet.skipped.reason}</p>
              <p className="mt-2 truncate text-xs text-muted-foreground">{tweet.originalText}</p>
            </div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {tweet.chunks.length > 1 ? (
                  <Badge variant="secondary">
                    <MessageSquare className="mr-1 h-3 w-3" />
                    {tweet.chunks.length}-post thread
                  </Badge>
                ) : null}
                {tweet.images > 0 ? (
                  <span className="flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" />
                    {tweet.images}
                  </span>
                ) : null}
                {tweet.video ? (
                  <span className="flex items-center gap-1">
                    <Video className="h-3 w-3" />
                    video
                  </span>
                ) : null}
                {tweet.linkCard ? (
                  <span className="flex items-center gap-1">
                    <Link2 className="h-3 w-3" />
                    link card
                  </span>
                ) : null}
                {tweet.quote ? (
                  <span className="flex items-center gap-1">
                    <Quote className="h-3 w-3" />
                    quote
                  </span>
                ) : null}
                {tweet.isReply ? <span>reply</span> : null}
              </div>
              <div className="space-y-2">
                {tweet.chunks.map((chunk, index) => (
                  <div
                    key={`${tweet.twitterId}-${index}`}
                    className="rounded-md border border-border/70 bg-muted/30 p-2 text-sm"
                  >
                    <p className="whitespace-pre-wrap break-words">{chunk.text}</p>
                    <p className="mt-1 text-right text-[11px] text-muted-foreground">{chunk.length}/300</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
