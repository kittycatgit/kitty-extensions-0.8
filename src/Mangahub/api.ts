/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { RequestManager } from "@paperback/types";

import { API_URL, CHAPTER_CRYPTO_URL, DOMAIN, HOST } from "./models";

/** A key the site issues for one access token, good for a few minutes. */
type ChapterKeys = { token: string; keys: Record<string, string>; expiresAt: number };

// The site's pages are client rendered and carry no content; it all comes from
// GraphQL, which since November 2026 only answers on the site's own origin.
export class MangaHubApi {
  private own = "";
  private chapterKeys: ChapterKeys | null = null;

  constructor(
    private readonly requestManager: () => RequestManager,
    /** The access token the site last issued, read from its `Set-Cookie`. */
    private readonly issuedToken: () => string | undefined,
  ) {}

  /**
   * The site issues one access token per visit and sends it as both the
   * `mhub_access` cookie and the `x-mhub-access` header; the API rejects a
   * request whose header and cookie disagree. So the token the site gave us wins,
   * and one of our own is minted only until it does.
   */
  private token(): string {
    const issued = this.issuedToken();

    if (issued) {
      return issued;
    }

    if (!this.own) {
      // The site's own token is 32 hex characters and the API only checks that
      // the header and the cookie carry the same one.
      let hex = "";
      while (hex.length < 32) {
        hex += Math.floor(Math.random() * 16).toString(16);
      }

      this.own = hex;
    }

    return this.own;
  }

  async query<T>(query: string, token: string = this.token()): Promise<T> {
    const response = await this.requestManager().schedule(
      App.createRequest({
        url: API_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // The site issues this and the API checks it against the cookie.
          "x-mhub-access": token,
          origin: DOMAIN,
        },
        cookies: [App.createCookie({ name: "mhub_access", value: token, domain: HOST })],
        data: JSON.stringify({ query }),
      }),
      1,
    );

    let payload: { data?: T; errors?: { message?: string }[] };
    try {
      payload = JSON.parse(response.data ?? "") as { data?: T; errors?: { message?: string }[] };
    } catch {
      throw new Error(
        `The API replied with something that was not JSON (status ${response.status})`,
      );
    }

    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message ?? "unknown").join("; ");

      // The API counts what each token has done and eventually retires it.
      if (/rate limit/i.test(message)) {
        this.own = "";
        this.chapterKeys = null;
      }

      throw new Error(message);
    }

    if (!payload.data) {
      throw new Error(`The API returned no data (status ${response.status})`);
    }

    return payload.data;
  }

  /**
   * Runs a chapter query, which the API answers with "Chapter encryption
   * unavailable" unless the token it arrives on already holds a decryption key.
   * Returns the keys the answer is encrypted with.
   */
  async queryChapter<T>(query: string): Promise<{ data: T; keys: Record<string, string> }> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.chapterSession();

      try {
        return { data: await this.query<T>(query, session.token), keys: session.keys };
      } catch (error: unknown) {
        this.chapterKeys = null;

        // A key the site has rotated away from reads as this, and a fresh one fixes it.
        if (
          attempt > 0 ||
          !/chapter encryption/i.test(String((error as Error)?.message ?? error))
        ) {
          throw error;
        }
      }
    }
  }

  private async chapterSession(): Promise<ChapterKeys> {
    if (this.chapterKeys && this.chapterKeys.expiresAt > Date.now() + 30_000) {
      return this.chapterKeys;
    }

    const token = this.token();
    const response = await this.requestManager().schedule(
      App.createRequest({
        url: CHAPTER_CRYPTO_URL,
        method: "GET",
        headers: { accept: "application/json", "x-mhub-access": token },
        cookies: [App.createCookie({ name: "mhub_access", value: token, domain: HOST })],
      }),
      1,
    );

    let payload: {
      keyId?: string;
      key?: string;
      keys?: Record<string, string>;
      expiresAt?: number;
    };
    try {
      payload = JSON.parse(response.data ?? "") as typeof payload;
    } catch {
      throw new Error(`The site did not hand out a chapter key (status ${response.status})`);
    }

    const keys = { ...payload.keys };
    if (payload.keyId && payload.key) {
      keys[payload.keyId] = payload.key;
    }

    if (Object.keys(keys).length === 0) {
      throw new Error(`The site handed out no chapter key (status ${response.status})`);
    }

    this.chapterKeys = {
      token,
      keys,
      expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : Date.now() + 300_000,
    };

    return this.chapterKeys;
  }
}

export function gqlString(value: string): string {
  return JSON.stringify(value);
}
