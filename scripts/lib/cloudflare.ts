/**
 * Minimal Cloudflare DNS client + public DNS verification, scoped to what the
 * handle migration needs: find the zone, upsert one TXT record, read it back.
 *
 * The API token needs Zone -> DNS -> Edit on the target zone.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CloudflareError {
  code: number;
  message: string;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: CloudflareError[] = [],
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  comment?: string;
}

export interface TokenStatus {
  id: string;
  status: string;
  expires_on?: string;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

/** Cloudflare returns TXT content quoted in some API versions; compare unquoted. */
export function unquoteTxt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export class CloudflareClient {
  constructor(private readonly token: string) {
    if (!token || !token.trim()) {
      throw new Error('Cloudflare API token is empty.');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: { success?: boolean; result?: T; errors?: CloudflareError[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new CloudflareApiError(
        `Cloudflare returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok || body.success === false) {
      const errors = body.errors ?? [];
      const detail = errors.map((e) => `[${e.code}] ${e.message}`).join('; ') || `HTTP ${response.status}`;
      throw new CloudflareApiError(`Cloudflare API error on ${path}: ${detail}`, response.status, errors);
    }

    return body.result as T;
  }

  /** Confirms the token is valid and active. */
  verifyToken(): Promise<TokenStatus> {
    return this.request<TokenStatus>('/user/tokens/verify');
  }

  async getZone(name: string): Promise<Zone> {
    const zones = await this.request<Zone[]>(`/zones?name=${encodeURIComponent(name)}`);
    const zone = zones?.[0];
    if (!zone) {
      throw new Error(
        `No Cloudflare zone named "${name}" is visible to this token. Check the domain spelling and that the token's zone scope includes it.`,
      );
    }
    return zone;
  }

  async findTxtRecord(zoneId: string, fqdn: string): Promise<DnsRecord | null> {
    const records = await this.request<DnsRecord[]>(
      `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`,
    );
    return records?.[0] ?? null;
  }

  createTxtRecord(zoneId: string, fqdn: string, content: string, ttl: number, comment?: string): Promise<DnsRecord> {
    return this.request<DnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'TXT', name: fqdn, content, ttl, ...(comment ? { comment } : {}) }),
    });
  }

  updateTxtRecord(
    zoneId: string,
    recordId: string,
    fqdn: string,
    content: string,
    ttl: number,
    comment?: string,
  ): Promise<DnsRecord> {
    return this.request<DnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'TXT', name: fqdn, content, ttl, ...(comment ? { comment } : {}) }),
    });
  }

  deleteRecord(zoneId: string, recordId: string): Promise<unknown> {
    return this.request(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  }
}

export type UpsertAction = 'created' | 'updated' | 'unchanged';

export interface UpsertResult {
  action: UpsertAction;
  record: DnsRecord;
}

export async function upsertTxtRecord(
  client: CloudflareClient,
  zoneId: string,
  fqdn: string,
  content: string,
  ttl: number,
  comment?: string,
): Promise<UpsertResult> {
  const existing = await client.findTxtRecord(zoneId, fqdn);
  if (!existing) {
    return { action: 'created', record: await client.createTxtRecord(zoneId, fqdn, content, ttl, comment) };
  }
  if (unquoteTxt(existing.content) === content) {
    return { action: 'unchanged', record: existing };
  }
  return { action: 'updated', record: await client.updateTxtRecord(zoneId, existing.id, fqdn, content, ttl, comment) };
}

/**
 * Resolve TXT records over DNS-over-HTTPS. This is the ground truth the Bluesky
 * PDS will look at, so we check it here rather than trusting the Cloudflare API
 * write to be immediately visible.
 */
export const DOH_RESOLVERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
] as const;

export async function resolveTxt(fqdn: string, resolverUrl: string): Promise<string[]> {
  const response = await fetch(`${resolverUrl}?name=${encodeURIComponent(fqdn)}&type=TXT`, {
    headers: { Accept: 'application/dns-json' },
  });
  if (!response.ok) {
    throw new Error(`DoH query failed (HTTP ${response.status}) for ${fqdn}`);
  }
  const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => unquoteTxt(a.data));
}

/** Nameservers the public DNS currently delegates a domain to (lowercase, no trailing dot). */
export async function resolveNs(domain: string, resolverUrl: string = DOH_RESOLVERS[0].url): Promise<string[]> {
  const response = await fetch(`${resolverUrl}?name=${encodeURIComponent(domain)}&type=NS`, {
    headers: { Accept: 'application/dns-json' },
  });
  if (!response.ok) {
    throw new Error(`DoH NS query failed (HTTP ${response.status}) for ${domain}`);
  }
  const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? [])
    .filter((a) => a.type === 2)
    .map((a) => a.data.trim().toLowerCase().replace(/\.$/, ''))
    .sort();
}

/**
 * True only when every delegated nameserver is Cloudflare's. A half-finished
 * change (some registrar nameservers still listed) means some resolvers will
 * not see records written through the Cloudflare API.
 */
export function isCloudflareDelegation(nameservers: string[]): boolean {
  return nameservers.length > 0 && nameservers.every((ns) => /\.ns\.cloudflare\.com$/.test(ns));
}

export interface PropagationResult {
  resolved: boolean;
  elapsedMs: number;
  attempts: number;
  seenValues: string[];
  resolversAgreeing: string[];
}

/** Poll public DNS until every resolver returns the expected TXT value. */
export async function waitForTxt(
  fqdn: string,
  expected: string,
  options: { timeoutMs?: number; intervalMs?: number; onAttempt?: (attempt: number, seen: string[]) => void } = {},
): Promise<PropagationResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const startedAt = Date.now();
  const seenValues = new Set<string>();
  let attempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const agreeing: string[] = [];

    for (const resolver of DOH_RESOLVERS) {
      try {
        const values = await resolveTxt(fqdn, resolver.url);
        for (const value of values) seenValues.add(value);
        if (values.includes(expected)) agreeing.push(resolver.name);
      } catch {
        // A resolver being briefly unreachable is not fatal; the loop retries.
      }
    }

    options.onAttempt?.(attempts, [...seenValues]);

    if (agreeing.length === DOH_RESOLVERS.length) {
      return {
        resolved: true,
        elapsedMs: Date.now() - startedAt,
        attempts,
        seenValues: [...seenValues],
        resolversAgreeing: agreeing,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    resolved: false,
    elapsedMs: Date.now() - startedAt,
    attempts,
    seenValues: [...seenValues],
    resolversAgreeing: [],
  };
}
