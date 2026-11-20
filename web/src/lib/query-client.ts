// One QueryClient for the dashboard. Defaults match how the app fetched before
// TanStack Query: no automatic retries (a failure is reported straight away),
// no refetch on window focus or reconnect, and polling keeps running in a
// background tab the way setInterval did.
import { QueryCache, QueryClient } from '@tanstack/react-query';

export interface DashboardQueryMeta extends Record<string, unknown> {
  /** Shown as an error notice when this query fails (401/403 signs out instead). */
  errorMessage?: string;
}

type QueryErrorHandler = (error: unknown, meta: DashboardQueryMeta | undefined) => void;
let queryErrorHandler: QueryErrorHandler | null = null;

/** Registered by the dashboard so failed queries reach handleAuthFailure. */
export function setQueryErrorHandler(handler: QueryErrorHandler | null) {
  queryErrorHandler = handler;
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => queryErrorHandler?.(error, query.meta as DashboardQueryMeta | undefined),
  }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchIntervalInBackground: true,
    },
  },
});
