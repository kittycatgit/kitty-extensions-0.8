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
const API = `${DOMAIN}/wp-json/wp/v2`;
const PAGE_SIZE = 30;

// The rendered catalogue ignores ?page= entirely, so browsing goes through the API.
const HOME_SECTIONS = [
  {
    id: "popular_today",
    title: "Popular Today",
    type: HomeSectionType.singleRowLarge,
    order: undefined,
  },
  {
    id: "latest_update",
    title: "Latest Update",
    type: HomeSectionType.singleRowNormal,
    order: "modified",
  },
  {
    id: "top_series",
    title: "Top Series",
    type: HomeSectionType.singleRowNormal,
    order: undefined,
  },
  { id: "new_series", title: "New Series", type: HomeSectionType.singleRowNormal, order: "date" },
] as const;

interface ApiManga {
  slug?: string;
  title?: { rendered?: string };
  _embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
}

interface Book {
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
}

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

  private catalogueUrl(page: number, orderBy?: string, search?: string): string {
    const parts = [`per_page=${PAGE_SIZE}`, `page=${page}`, "_embed=wp:featuredmedia"];

    if (orderBy) {
      parts.push(`orderby=${orderBy}`, "order=desc");
    }

    if (search) {
      parts.push(`search=${encodeURIComponent(search)}`);
    }

    return `${API}/manga?${parts.join("&")}`;
  }

  private async catalogue(url: string): Promise<PagedResults> {
    const rows = JSON.parse(await this.fetch(url)) as ApiManga[];
    const results: PartialSourceManga[] = [];

    for (const row of rows) {
      const slug = (row.slug ?? "").trim();

      // /manga/feed/ is WordPress' RSS endpoint, not a title.
      if (!slug || slug === "feed") {
        continue;
      }

      results.push(
        App.createPartialSourceManga({
          mangaId: slug,
          title: this.decode(row.title?.rendered ?? slug),
          image: row._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? `${DOMAIN}/favicon.ico`,
        }),
      );
    }

    return App.createPagedResults({ results });
  }

  private sectionTiles(html: string, title: string, next?: string): PartialSourceManga[] {
    const start = html.indexOf(title);

    if (start < 0) {
      return [];
    }

    const end = next ? html.indexOf(next, start + title.length) : -1;
    const $ = this.cheerio.load(html.slice(start, end > 0 ? end : undefined));
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/manga/"]').toArray()) {
      const href = ($(element).attr("href") ?? "").trim();
      const slug = /\/manga\/([a-z0-9-]+)\/?$/.exec(href)?.[1] ?? "";
      const image = $(element).find("img").first();
      const name = (image.attr("alt") ?? "").trim();

      if (!slug || slug === "feed" || !name || seen.has(slug)) {
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
    for (const entry of HOME_SECTIONS) {
      sectionCallback(
        App.createHomeSection({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          containsMoreItems: entry.order !== undefined,
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
          containsMoreItems: entry.order !== undefined,
          items: this.sectionTiles(html, entry.title, HOME_SECTIONS[index + 1]?.title),
        }),
      );
    }
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const entry = HOME_SECTIONS.find((row) => row.id === homepageSectionId);

    // The API can order by date and modification, but has no notion of popularity.
    if (!entry?.order) {
      return App.createPagedResults({ results: [] });
    }

    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const results = await this.catalogue(this.catalogueUrl(page, entry.order));

    return App.createPagedResults({
      results: results.results,
      metadata: (results.results?.length ?? 0) < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const results = await this.catalogue(
      this.catalogueUrl(page, undefined, (query.title ?? "").trim() || undefined),
    );

    return App.createPagedResults({
      results: results.results,
      metadata: (results.results?.length ?? 0) < PAGE_SIZE ? undefined : { page: page + 1 },
    });
  }

  private book(html: string): Book {
    for (const match of html.matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    )) {
      try {
        const parsed = JSON.parse(match[1] ?? "") as Record<string, unknown>;
        const type = parsed["@type"];

        if (type === "Book" || (Array.isArray(type) && type.includes("Book"))) {
          return parsed as Book;
        }
      } catch {
        continue;
      }
    }

    return {};
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const book = this.book(await this.fetch(this.getMangaShareUrl(mangaId)));
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

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const $ = this.cheerio.load(await this.fetch(this.getMangaShareUrl(mangaId)));
    const chapters: Chapter[] = [];
    const seen = new Set<string>();

    for (const element of $('a[href*="/chapter-"]').toArray()) {
      // The theme writes these hrefs with a leading space inside the attribute.
      const href = ($(element).attr("href") ?? "").trim();
      const id = /\/manga\/[a-z0-9-]+\/(chapter-[\d.]+)\/?$/.exec(href)?.[1] ?? "";

      if (!id || seen.has(id)) {
        continue;
      }

      seen.add(id);
      chapters.push(
        App.createChapter({
          id,
          // id is chapter-{num}.{postId}, so the post id is after the last dot.
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

    // The CDN names the series differently, so page URLs are read, not built.
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
