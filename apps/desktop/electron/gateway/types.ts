export type GatewayProvider = "spotify" | "soundcloud" | "deezer" | "youtube";

export interface GatewayRequest {
  provider: GatewayProvider;
  operation: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  fallback?: "public" | "none";
}

export interface GatewayResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  source: "internal" | "public" | "cache" | "fallback";
  cachedAt?: number;
}

export interface CacheEntry {
  key: string;
  data: unknown;
  etag?: string;
  expiresAt: number;
  createdAt: number;
}

export interface StealthRequestInit {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: "follow" | "error" | "manual";
}

export interface StealthResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}
