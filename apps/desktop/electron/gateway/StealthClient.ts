import { net } from "electron";
import type { StealthRequestInit, StealthResponse } from "./types";

interface CookieJarEntry {
  value: string;
  domain: string;
  path: string;
  expires?: number;
}

export class StealthClient {
  private cookieJar = new Map<string, CookieJarEntry[]>();
  private defaultHeaders: Record<string, string>;
  private disableCookies: boolean;

  constructor(userAgent?: string, options?: { disableCookies?: boolean }) {
    this.disableCookies = options?.disableCookies ?? false;
    this.defaultHeaders = {
      "User-Agent":
        userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    };
  }

  async request(url: string, init: StealthRequestInit = {}): Promise<StealthResponse> {
    return new Promise((resolve, reject) => {
      const method = init.method ?? "GET";
      const clientRequest = net.request({
        method,
        url,
        redirect: init.redirect ?? "follow"
      });

      // Apply default + custom headers
      const headers = { ...this.defaultHeaders, ...init.headers };
      for (const [key, value] of Object.entries(headers)) {
        if (value) {
          clientRequest.setHeader(key, value);
        }
      }

      // Apply cookies for this domain. SoundCloud's anonymous api-v2 + media endpoints work
      // without cookies, and accumulating them across a session can poison the media endpoint
      // (causing 404s on stream resolution), so cookie handling is opt-out per client.
      if (!this.disableCookies) {
        const domainCookies = this.getCookiesForUrl(url);
        if (domainCookies) {
          clientRequest.setHeader("Cookie", domainCookies);
        }
      }

      // Idle deadline: the timer re-arms on headers and on every body chunk, so a slow-but-moving
      // download never times out while a server that stalls (before OR mid-body) gets aborted.
      // Clearing the timer at first headers used to leave a mid-body stall hanging this promise
      // (and the renderer invoke) forever.
      const timeoutMs = init.timeoutMs ?? 30000;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          finish(() => {
            clientRequest.abort();
            reject(new Error(`Request timeout: ${url}`));
          });
        }, timeoutMs);
      };
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        settle();
      };
      armTimeout();

      let body = "";

      clientRequest.on("response", (response) => {
        armTimeout();
        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        for (const [key, values] of Object.entries(response.headers)) {
          if (Array.isArray(values)) {
            responseHeaders[key.toLowerCase()] = values.join(", ");
          } else if (typeof values === "string") {
            responseHeaders[key.toLowerCase()] = values;
          }
        }

        // Store Set-Cookie headers from the raw (un-joined) header value — joining on "," first
        // corrupts cookies whose Expires attribute itself contains a comma.
        const rawSetCookie = response.headers["set-cookie"];
        if (rawSetCookie && !this.disableCookies) {
          this.storeCookies(url, Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie]);
        }

        response.on("data", (chunk: Buffer) => {
          armTimeout();
          body += chunk.toString("utf8");
        });

        response.on("end", () => {
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
              body
            })
          );
        });

        response.on("error", (error: Error) => {
          finish(() => reject(error));
        });
      });

      clientRequest.on("error", (error: Error) => {
        finish(() => reject(error));
      });

      if (init.body) {
        clientRequest.write(init.body);
      }

      clientRequest.end();
    });
  }

  setDefaultHeader(key: string, value: string): void {
    this.defaultHeaders[key] = value;
  }

  clearCookies(): void {
    this.cookieJar.clear();
  }

  private getCookiesForUrl(url: string): string | undefined {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const path = parsed.pathname;

    const entries: string[] = [];
    for (const [cookieDomain, cookies] of this.cookieJar) {
      if (domain.endsWith(cookieDomain) || cookieDomain.endsWith(domain)) {
        for (const cookie of cookies) {
          if (path.startsWith(cookie.path)) {
            if (!cookie.expires || cookie.expires > Date.now()) {
              entries.push(`${cookie.value}`);
            }
          }
        }
      }
    }

    return entries.length > 0 ? entries.join("; ") : undefined;
  }

  private storeCookies(url: string, setCookieHeaders: string[]): void {
    const parsed = new URL(url);
    const domain = parsed.hostname;

    const existing = this.cookieJar.get(domain) ?? [];

    for (const header of setCookieHeaders) {
      const [nameValue, ...attributes] = header.split(";");
      const trimmed = nameValue.trim();
      const name = trimmed.split("=")[0]?.trim();
      if (!trimmed || !name) {
        continue;
      }

      let path = "/";
      let expires: number | undefined;
      for (const attribute of attributes) {
        const [attrName, ...attrRest] = attribute.split("=");
        const attrValue = attrRest.join("=").trim();
        const key = attrName.trim().toLowerCase();
        if (key === "path" && attrValue) {
          path = attrValue;
        } else if (key === "max-age" && attrValue) {
          const seconds = Number(attrValue);
          if (Number.isFinite(seconds)) {
            expires = Date.now() + seconds * 1000;
          }
        } else if (key === "expires" && attrValue && expires === undefined) {
          const at = Date.parse(attrValue);
          if (Number.isFinite(at)) {
            expires = at;
          }
        }
      }

      // Replace by cookie NAME so re-issued cookies update in place instead of accumulating a
      // duplicate on every response.
      const staleIndex = existing.findIndex((cookie) => cookie.value.split("=")[0] === name);
      const entry: CookieJarEntry = { value: trimmed, domain, path, expires };
      if (staleIndex >= 0) {
        existing[staleIndex] = entry;
      } else {
        existing.push(entry);
      }
    }

    // Drop already-expired cookies so the per-domain jar can't grow without bound.
    this.cookieJar.set(
      domain,
      existing.filter((cookie) => !cookie.expires || cookie.expires > Date.now())
    );
  }
}
