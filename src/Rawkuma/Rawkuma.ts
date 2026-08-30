import { CheerioAPI } from "cheerio";
import {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  ContentRating,
  HomePageSectionsProviding,
  HomeSection,
  HomeSectionType,
  PagedResults,
  PartialSourceManga,
  Request,
  RequestManager,
  SearchRequest,
  SearchResultsProviding,
  SourceInfo,
  SourceIntents,
  SourceManga,
} from "@paperback/types";

const DOMAIN = "https://rawkuma.net";

/**
 * The site's own WordPress API.
 *
 * The catalogue pages rendered for a browser hold a few dozen titles and ignore
 * `?page=` entirely - asking for pages one, two and three returns the same rows.
 * The API behind them answers with the whole library, pages honestly, and states
 * how many pages there are, so browsing and searching are read from here rather
 * than scraped.
 */
const API = `${DOMAIN}/wp-json/wp/v2`;

/** The most the API will return at once, whatever is asked for. */
const PAGE_SIZE = 30;

/**
 * The sections the site puts on its own front page, in its own order.
 *
 * These are read out of the homepage rather than invented, so the rows here are
 * the rows a reader sees on the site. They are not paged: the page holds one
 * batch of each and offers no way to ask for more.
 */
const HOME_SECTIONS = [
  { id: "popular_today", title: "Popular Today", type: HomeSectionType.singleRowLarge },
  { id: "latest_update", title: "Latest Update", type: HomeSectionType.singleRowNormal },
  { id: "top_series", title: "Top Series", type: HomeSectionType.singleRowNormal },
  { id: "new_series", title: "New Series", type: HomeSectionType.singleRowNormal },
] as const;

export const RawkumaInfo: SourceInfo = {
  version: "1.0.0",
  name: "Rawkuma",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from rawkuma.net.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "ja",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class Rawkuma
  implements
    SearchResultsProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding
{
  constructor(public cheerio: CheerioAPI) {}

  readonly requestManager: RequestManager = App.createRequestManager({
    requestsPerSecond: 4,
    requestTimeout: 20_000,
    interceptor: {
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          ...request.headers,
          referer: `${DOMAIN}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
        };

        return request;
      },
      interceptResponse: async (response) => response,
    },
  });

  /**
   * The site sits behind Cloudflare, which challenges a native client where it
   * waves a browser through. Handing the app the site root lets it solve the
   * challenge in a webview and keep the cookies for later requests.
   */
  async getCloudflareBypassRequestAsync(): Promise<Request> {
    return App.createRequest({
      url: DOMAIN,
      method: "GET",
      headers: {
        referer: `${DOMAIN}/`,
        "user-agent": await this.requestManager.getDefaultUserAgent(),
      },
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/manga/${mangaId}/`;
  }

  private async fetch(url: string): Promise<string> {
    const response = await this.requestManager.schedule(
      App.createRequest({ url, method: "GET" }),
      1,
    );

    return typeof response.data === "string" ? response.data : String(response.data ?? "");
  }

  private async json<T>(url: string): Promise<T> {
    return JSON.parse(await this.fetch(url)) as T;
  }

  /**
   * A catalogue row as the API describes it.
   *
   * The cover is asked for in the same call rather than fetched per title: the
   * API will embed it, and a request per row would be a request per row.
   */
  private toTile(entry: {
    slug?: string;
    title?: { rendered?: string };
    _embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
  }): PartialSourceManga | undefined {
    const slug = (entry.slug ?? "").trim();

    if (!slug || slug === "feed") {
      // `/manga/feed/` is WordPress' own RSS endpoint, not a title.
      return undefined;
    }

    const media = entry._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? "";

    return App.createPartialSourceManga({
      mangaId: slug,
      title: this.decode(entry.title?.rendered ?? slug),
      image: media || `${DOMAIN}/favicon.ico`,
    });
  }

  /** WordPress renders titles with HTML entities in them. */
  private decode(value: string): string {
    return value
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  /**
   * The titles a homepage section holds.
   *
   * The page is one document with the sections laid out in order, so a section
   * is the run of markup between its own heading and the next one. Cards are
   * found by their link rather than by class: the theme's classes are utility
   * ones that change with the layout, while the link to a title does not.
   */
  private sectionTiles(
    html: string,
    title: string,
    nextTitle: string | undefined,
  ): PartialSourceManga[] {
    const start = html.indexOf(title);

    if (start < 0) {
      return [];
    }

    const after = nextTitle ? html.indexOf(nextTitle, start + title.length) : -1;
    const block = html.slice(start, after > 0 ? after : undefined);
    const $ = this.cheerio.load(block);
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/manga/"]').toArray()) {
      const href = ($(element).attr("href") ?? "").trim();
      const slug = /\/manga\/([a-z0-9-]+)\/?$/.exec(href)?.[1] ?? "";

      if (!slug || slug === "feed" || seen.has(slug)) {
        continue;
      }

      const image = $(element).find("img").first();
      const name = (image.attr("alt") ?? "").trim();

      if (!name) {
        continue;
      }

      seen.add(slug);
      tiles.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title: this.decode(name),
          image: (image.attr("src") ?? "").trim() || `${DOMAIN}/favicon.ico`,
        }),
      );
    }

    return tiles;
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    // The rows are handed over empty first so the app can draw them, then filled
    // from the one page they all come from.
    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          containsMoreItems: false,
        }),
      );
    }

    const html = await this.fetch(`${DOMAIN}/`);

    for (const [index, entry] of HOME_SECTIONS.entries()) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          containsMoreItems: false,
          items: this.sectionTiles(html, entry.title, HOME_SECTIONS[index + 1]?.title),
        }),
      );
    }
  }

  /**
   * The homepage rows are what the site itself shows and offer no more than
   * that, so there is nothing further to hand over.
   */
  async getViewMoreItems(_homepageSectionId: string, _metadata: unknown): Promise<PagedResults> {
    return App.createPagedResults({ results: [] });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const title = (query.title ?? "").trim();
    const url =
      `${API}/manga?per_page=${PAGE_SIZE}&page=${page}&_embed=wp:featuredmedia` +
      (title ? `&search=${encodeURIComponent(title)}` : "");

    const rows = await this.json<Parameters<Rawkuma["toTile"]>[0][]>(url);
    const results = rows
      .map((row) => this.toTile(row))
      .filter((tile): tile is PartialSourceManga => tile !== undefined);

    return App.createPagedResults({
      results,
      // A short page is the last one; the API answers an over-run page with an
      // error rather than an empty list, so asking again would fail loudly.
      metadata: results.length < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const html = await this.fetch(this.getMangaShareUrl(mangaId));
    const book = this.book(html);
    const genres = (book.genre ?? []).map((name) =>
      App.createTag({ id: name.toLowerCase(), label: name }),
    );

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [
          this.decode(book.name ?? mangaId),
          ...(book.alternateName ? [this.decode(book.alternateName)] : []),
        ],
        image: book.image?.url ?? `${DOMAIN}/favicon.ico`,
        desc: this.decode(book.description ?? ""),
        status: book.creativeWorkStatus ?? (book.isCompleted ? "Completed" : "Ongoing"),
        ...(book.author?.name ? { author: book.author.name } : {}),
        ...(book.illustrator?.name ? { artist: book.illustrator.name } : {}),
        ...(book.aggregateRating?.ratingValue
          ? { rating: Number(book.aggregateRating.ratingValue) }
          : {}),
        ...(genres.length > 0
          ? { tags: [App.createTagSection({ id: "genres", label: "Genres", tags: genres })] }
          : {}),
      }),
    });
  }

  /**
   * The series' own description, as the page states it for search engines.
   *
   * Taken from the page's structured data rather than its markup: the theme is
   * built from utility classes that carry no meaning, while this block names
   * every field it holds.
   */
  private book(html: string): {
    name?: string;
    alternateName?: string;
    description?: string;
    image?: { url?: string };
    author?: { name?: string };
    illustrator?: { name?: string };
    genre?: string[];
    creativeWorkStatus?: string;
    isCompleted?: boolean;
    aggregateRating?: { ratingValue?: number | string };
  } {
    for (const match of html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    )) {
      try {
        const parsed = JSON.parse(match[1] ?? "") as Record<string, unknown>;
        const type = parsed["@type"];
        const isBook = type === "Book" || (Array.isArray(type) && type.includes("Book"));

        if (isBook) {
          return parsed as ReturnType<Rawkuma["book"]>;
        }
      } catch {
        // A block that will not parse is not the one wanted.
      }
    }

    return {};
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = this.cheerio.load(await this.fetch(this.getMangaShareUrl(mangaId)));
    const chapters: Chapter[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/chapter-"]').toArray()) {
      // The theme writes these hrefs with a leading space inside the attribute,
      // which would otherwise be carried into the request.
      const href = ($(element).attr("href") ?? "").trim();
      const id = /\/manga\/[a-z0-9-]+\/(chapter-[\d.]+)\/?$/.exec(href)?.[1] ?? "";

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      chapters.push(
        App.createChapter({
          id,
          // The id carries the chapter number and the site's own post number,
          // separated by a dot - and a half chapter carries a dot of its own, so
          // the post number is everything after the *last* one. Reading it as a
          // single decimal turns chapter 0 into 0.255192.
          chapNum: Number(id.replace(/^chapter-/, "").replace(/\.[^.]*$/, "")) || 0,
          langCode: "ja",
          name: this.decode($(element).text()),
        }),
      );
    }

    const sorted = chapters.sort((left, right) => right.chapNum - left.chapNum);

    return sorted.map((chapter, index) => ({ ...chapter, sortingIndex: sorted.length - index }));
  }

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const $ = this.cheerio.load(await this.fetch(`${DOMAIN}/manga/${mangaId}/${chapterId}/`));
    const pages: string[] = [];

    // The pages are served from a separate host whose own name for the series
    // does not match this one, so the addresses are read from the page in the
    // order it lists them rather than built.
    for (const element of $("img").toArray()) {
      const src = ($(element).attr("src") ?? "").trim();

      if (src.includes("rcdn.") && !pages.includes(src)) {
        pages.push(src);
      }
    }

    if (pages.length === 0) {
      throw new Error(`No pages were found for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}
