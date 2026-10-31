/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

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
  Tag,
  TagSection,
} from "@paperback/types";

import {
  appScriptUrl,
  deriveKey,
  manifestPages,
  manifestUrl,
  readerConfig,
  widest,
} from "./reader";

const DOMAIN = "https://coffeemanga.net";
const CHAPTER_BATCH = 4;

// Every page is an Inertia app: the props sit in a JSON <script> and the
// markup around them is only the first paint.
type ChapterRef = {
  slug: string;
  label: string;
  published_at?: string | null;
  published_label?: string;
  locked?: boolean;
  number?: string | number | null;
  title?: string | null;
};

type Taxon = { slug: string; name: string };

type Card = {
  slug: string;
  title: string;
  type?: string;
  status?: string;
  cover?: string;
  cover_srcset?: string;
  cover_lg?: string;
  cover_canonical?: string;
  chapters?: ChapterRef[];
  is_adult?: boolean;
};

type Series = Card & {
  alt_titles?: string[];
  synopsis?: string | null;
  genres?: Taxon[];
  tags?: Taxon[];
  authors?: (Taxon | string)[];
  artists?: (Taxon | string)[];
};

type Pagination = { page: number; last: number };
type HomeProps = { heroes?: Card[]; sections?: { code: string; items?: Card[] }[] };
type ListingProps = { series?: Card[]; pagination?: Pagination; filters?: { genres?: Taxon[] } };
type SeriesProps = { series?: Series; rating?: { avg?: number | null } };
type ReaderProps = { series?: { slug: string }; chapter?: { id: number }; reader?: { x?: string } };
type ChapterPage = { items: ChapterRef[]; last: number };

// Home rails in the site's own order; `order` is the library ordering that
// pages a rail past the home page.
const HOME_ROWS = [
  { id: "featured", title: "Featured", type: HomeSectionType.singleRowLarge, code: "heroes" },
  {
    id: "latest",
    title: "Latest updates",
    type: HomeSectionType.singleRowNormal,
    code: "latest",
    order: "reciente",
  },
  {
    id: "reading_now",
    title: "Most read right now",
    type: HomeSectionType.singleRowNormal,
    code: "reading_now",
  },
  {
    id: "trending",
    title: "Popular this week",
    type: HomeSectionType.singleRowLarge,
    code: "trending",
  },
  {
    id: "newest",
    title: "Newly added",
    type: HomeSectionType.singleRowNormal,
    code: "newest",
    order: "nuevas",
  },
] as const;

const LIBRARY_ROWS = [
  { id: "most_viewed", title: "Most viewed", order: "vistas" },
  { id: "top_rated", title: "Top rated", order: "valoradas" },
  { id: "most_followed", title: "Most followed", order: "seguidas" },
] as const;

// Tag ids carry their filter as a prefix so one includedTags list can hold a
// genre, a type, a status and a section at once.
const FILTERS = [
  {
    id: "type",
    label: "Type",
    param: "tipo",
    items: ["manga", "manhwa", "manhua", "webtoon", "novel"],
  },
  {
    id: "status",
    label: "Status",
    param: "estado",
    items: ["ongoing", "completed", "hiatus", "cancelled"],
  },
  { id: "section", label: "Section", param: "seccion", items: ["shoujo", "shounen"] },
] as const;

const STATUS_LABELS: Record<string, string> = {
  ongoing: "Ongoing",
  completed: "Completed",
  hiatus: "Hiatus",
  cancelled: "Cancelled",
};

// An empty image fails the whole row, so coverless titles point at a path the
// host won't serve and the app draws its placeholder.
const MISSING_COVER = `${DOMAIN}/image/none.webp`;

export const CoffeeMangaInfo: SourceInfo = {
  version: "5.0.0",
  name: "CoffeeManga",
  icon: "icon.png",
  author: "kittycatgit",
  authorWebsite: "https://github.com/kittycatgit",
  description: "Extension that pulls content from coffeemanga.net.",
  contentRating: ContentRating.MATURE,
  websiteBaseURL: DOMAIN,
  language: "en",
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
};

export class CoffeeManga
  implements
    SearchResultsProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding
{
  constructor(public cheerio: unknown) {}

  // The app bundle is ~350 KB and only changes on deploy; keep one key per URL.
  private keyCache: { url: string; key: Uint8Array } | undefined;

  readonly requestManager: RequestManager = App.createRequestManager({
    requestTimeout: 20_000,
    interceptor: {
      // Defaults only: the page manifest is refused unless its referer is the
      // chapter page, so a caller's own headers win.
      interceptRequest: async (request: Request): Promise<Request> => {
        request.headers = {
          referer: `${DOMAIN}/`,
          "user-agent": await this.requestManager.getDefaultUserAgent(),
          ...request.headers,
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

  private async fetch(url: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await this.requestManager.schedule(
      App.createRequest({ url, method: "GET", headers }),
      1,
    );

    if (response.status === 428) {
      throw new Error("The site is asking for a browser verification before serving pages.");
    }

    if (response.status !== 200) {
      throw new Error(`${url} answered ${response.status}.`);
    }

    return typeof response.data === "string" ? response.data : String(response.data ?? "");
  }

  private props<P>(html: string): P {
    const match = /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    );

    if (!match) {
      throw new Error("The page carried no Inertia data; the site may have changed or challenged.");
    }

    return (JSON.parse(match[1] ?? "{}") as { props: P }).props;
  }

  private async page<P>(url: string): Promise<P> {
    return this.props<P>(await this.fetch(url));
  }

  // The library ignores ?page=; only the /page/N/ path form pages.
  private libraryUrl(page: number, params: Record<string, string>): string {
    const query = Object.entries(params)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");

    return `${DOMAIN}/manga/${page > 1 ? `page/${page}/` : ""}${query ? `?${query}` : ""}`;
  }

  private absolute(url: string): string {
    const trimmed = url.trim();

    if (trimmed.startsWith("//")) {
      return `https:${trimmed}`;
    }

    return (trimmed.startsWith("/") ? `${DOMAIN}${trimmed}` : trimmed).replace(
      /^http:\/\//,
      "https://",
    );
  }

  private cover(card: Card): string {
    const best =
      card.cover_canonical || card.cover_lg || widest(card.cover_srcset ?? "") || card.cover || "";

    return best ? this.absolute(best) : MISSING_COVER;
  }

  private tiles(cards: Card[] | undefined): PartialSourceManga[] {
    const tiles: PartialSourceManga[] = [];
    const seen = new Set<string>();

    for (const card of cards ?? []) {
      if (!card.slug || !card.title || seen.has(card.slug)) {
        continue;
      }

      seen.add(card.slug);

      const latest = card.chapters?.[0];
      const subtitle = latest
        ? latest.published_label
          ? `${latest.label.trim()} · ${latest.published_label}`
          : latest.label.trim()
        : "";

      tiles.push(
        App.createPartialSourceManga({
          mangaId: card.slug,
          title: card.title.trim(),
          image: this.cover(card),
          ...(subtitle ? { subtitle } : {}),
        }),
      );
    }

    return tiles;
  }

  private async listing(page: number, params: Record<string, string>): Promise<PagedResults> {
    const props = await this.page<ListingProps>(this.libraryUrl(page, params));
    const results = this.tiles(props.series);
    const last = props.pagination?.last ?? page;

    return App.createPagedResults({
      results,
      metadata: results.length === 0 || page >= last ? undefined : { page: page + 1 },
    });
  }

  async getSearchTags(): Promise<TagSection[]> {
    const props = await this.page<ListingProps>(this.libraryUrl(1, {}));
    const genres = (props.filters?.genres ?? [])
      .filter((genre) => genre.slug && genre.name)
      .map((genre) => App.createTag({ id: `genre:${genre.slug}`, label: genre.name.trim() }));

    if (genres.length === 0) {
      throw new Error("The library page listed no genres.");
    }

    const title = (value: string) =>
      value === "hiatus" ? "On hiatus" : value.charAt(0).toUpperCase() + value.slice(1);

    return [
      App.createTagSection({ id: "genre", label: "Genre", tags: genres }),
      ...FILTERS.map((filter) =>
        App.createTagSection({
          id: filter.id,
          label: filter.label,
          tags: filter.items.map((item) =>
            App.createTag({ id: `${filter.id}:${item}`, label: title(item) }),
          ),
        }),
      ),
    ];
  }

  async supportsTagExclusion(): Promise<boolean> {
    return false;
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    const rows = [
      ...HOME_ROWS.map((row) => ({ ...row, more: "order" in row })),
      ...LIBRARY_ROWS.map((row) => ({ ...row, type: HomeSectionType.singleRowNormal, more: true })),
    ];

    for (const row of rows) {
      sectionCallback(
        App.createHomeSection({
          id: row.id,
          title: row.title,
          type: row.type,
          containsMoreItems: row.more,
        }),
      );
    }

    const home = await this.page<HomeProps>(`${DOMAIN}/`);

    for (const row of HOME_ROWS) {
      const cards =
        row.code === "heroes"
          ? home.heroes
          : home.sections?.find((section) => section.code === row.code)?.items;

      if (!cards?.length) {
        throw new Error(`The home page carried no "${row.title}" rail.`);
      }

      sectionCallback(
        App.createHomeSection({
          id: row.id,
          title: row.title,
          type: row.type,
          containsMoreItems: "order" in row,
          items: this.tiles(cards),
        }),
      );
    }

    for (const row of LIBRARY_ROWS) {
      sectionCallback(
        App.createHomeSection({
          id: row.id,
          title: row.title,
          type: HomeSectionType.singleRowNormal,
          containsMoreItems: true,
          items: (await this.listing(1, { orden: row.order })).results,
        }),
      );
    }
  }

  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const row = [...HOME_ROWS, ...LIBRARY_ROWS].find((entry) => entry.id === homepageSectionId);

    if (!row || !("order" in row)) {
      throw new Error(`Invalid sectionId provided: ${homepageSectionId}`);
    }

    const page = (metadata as { page?: number } | undefined)?.page ?? 1;

    return this.listing(page, { orden: row.order });
  }

  // /search knows only the title; the library knows every filter but no
  // title. With both, the filtered listing is matched page by page.
  async getSearchResults(query: SearchRequest, metadata: unknown): Promise<PagedResults> {
    const page = (metadata as { page?: number } | undefined)?.page ?? 1;
    const title = (query.title ?? "").trim();
    const params: Record<string, string> = { orden: "reciente" };
    let tagSlug = "";

    for (const tag of query.includedTags ?? []) {
      const [kind, value] = tag.id.split(":", 2);
      const param = kind === "genre" ? "genero" : FILTERS.find((f) => f.id === kind)?.param;

      if (kind === "tag" && value) {
        tagSlug = value;
      } else if (param && value) {
        params[param] = value;
      }
    }

    const filtered = Object.keys(params).length > 1;

    // Tags (from a series page) only have their own listing, which takes no
    // other filter.
    if (tagSlug) {
      if (filtered) {
        throw new Error("A tag cannot be combined with other filters on this site.");
      }

      const props = await this.page<ListingProps>(
        `${DOMAIN}/manga-tag/${tagSlug}/${page > 1 ? `page/${page}/` : ""}`,
      );
      const results = this.tiles(props.series);
      const last = props.pagination?.last ?? page;

      return App.createPagedResults({
        results: title
          ? results.filter((row) => (row.title ?? "").toLowerCase().includes(title.toLowerCase()))
          : results,
        metadata: results.length === 0 || page >= last ? undefined : { page: page + 1 },
      });
    }

    if (!filtered && title) {
      const props = await this.page<ListingProps>(
        `${DOMAIN}/search?q=${encodeURIComponent(title)}${page > 1 ? `&page=${page}` : ""}`,
      );
      const results = this.tiles(props.series);
      const last = props.pagination?.last ?? page;

      return App.createPagedResults({
        results,
        metadata: results.length === 0 || page >= last ? undefined : { page: page + 1 },
      });
    }

    const listing = await this.listing(page, filtered ? params : { orden: "vistas" });

    return App.createPagedResults({
      results: title
        ? listing.results.filter((row) =>
            (row.title ?? "").toLowerCase().includes(title.toLowerCase()),
          )
        : listing.results,
      metadata: listing.metadata,
    });
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const props = await this.page<SeriesProps>(this.getMangaShareUrl(mangaId));
    const series = props.series;

    if (!series?.title) {
      throw new Error(`No series data was returned for ${mangaId}.`);
    }

    const tagsOf = (prefix: string, taxa: Taxon[] | undefined): Tag[] =>
      (taxa ?? [])
        .filter(
          (taxon, index, all) =>
            taxon.slug && all.findIndex((t) => t.slug === taxon.slug) === index,
        )
        .map((taxon) => App.createTag({ id: `${prefix}:${taxon.slug}`, label: taxon.name.trim() }));

    const genres = tagsOf("genre", series.genres);
    const tags = tagsOf("tag", series.tags);
    const nameOf = (entry: Taxon | string) =>
      (typeof entry === "string" ? entry : entry.name).trim();
    const rating = Number(props.rating?.avg);
    const adult =
      series.is_adult === true ||
      genres.some((genre) => /^genre:(adult|mature|smut|ecchi|hentai)$/i.test(genre.id));

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [series.title.trim(), ...(series.alt_titles ?? []).map((t) => t.trim())].filter(
          Boolean,
        ),
        image: this.cover(series),
        desc: (series.synopsis ?? "").trim(),
        status: STATUS_LABELS[series.status ?? ""] ?? "Unknown",
        hentai: adult,
        author: (series.authors ?? []).map(nameOf).filter(Boolean).join(", "),
        artist: (series.artists ?? []).map(nameOf).filter(Boolean).join(", "),
        ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
        tags: [
          ...(genres.length
            ? [App.createTagSection({ id: "genres", label: "Genres", tags: genres })]
            : []),
          ...(tags.length ? [App.createTagSection({ id: "tags", label: "Tags", tags })] : []),
        ],
      }),
    });
  }

  // 20 rows per page, newest first.
  private async chapterPage(mangaId: string, page: number): Promise<ChapterPage> {
    const body = JSON.parse(
      await this.fetch(`${DOMAIN}/manga/${mangaId}/chapters/${page}.json`, {
        accept: "application/json",
      }),
    ) as Partial<ChapterPage>;

    if (!Array.isArray(body.items) || typeof body.last !== "number") {
      throw new Error(`The chapter list for ${mangaId} has an unexpected shape.`);
    }

    return { items: body.items, last: body.last };
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const first = await this.chapterPage(mangaId, 1);
    const rows = [...first.items];

    for (let page = 2; page <= first.last; page += CHAPTER_BATCH) {
      const batch = [];

      for (let n = page; n < page + CHAPTER_BATCH && n <= first.last; n++) {
        batch.push(this.chapterPage(mangaId, n));
      }

      for (const result of await Promise.all(batch)) {
        rows.push(...result.items);
      }
    }

    const seen = new Set<string>();
    const entries = rows
      .filter((row) => row.slug && !seen.has(row.slug) && seen.add(row.slug))
      .map((row) => {
        const explicit = Number(row.number);
        const chapNum =
          row.number !== null && row.number !== "" && Number.isFinite(explicit)
            ? explicit
            : Number(/([0-9]+(?:\.[0-9]+)?)/.exec(row.label)?.[1] ?? 0);
        const name = (row.title ?? "").trim();
        const time = row.published_at ? new Date(row.published_at) : undefined;

        return {
          id: row.slug,
          chapNum,
          name: row.locked ? (name ? `${name} (locked)` : "Locked") : name,
          time: time && !isNaN(time.getTime()) ? time : undefined,
        };
      });

    if (entries.length === 0) {
      throw new Error(`No chapters were listed for ${mangaId}.`);
    }

    entries.sort((left, right) => right.chapNum - left.chapNum);

    // Chapters are built once, with their order: spreading one back into a plain
    // object loses what the app needs on the other side of the bridge.
    return entries.map((row, index) =>
      App.createChapter({
        id: row.id,
        chapNum: row.chapNum,
        langCode: "en",
        sortingIndex: entries.length - index,
        ...(row.name ? { name: row.name } : {}),
        ...(row.time ? { time: row.time } : {}),
      }),
    );
  }

  private async readerKey(scriptUrl: string): Promise<Uint8Array> {
    if (this.keyCache?.url === scriptUrl) {
      return this.keyCache.key;
    }

    const key = deriveKey(await this.fetch(scriptUrl));
    this.keyCache = { url: scriptUrl, key };

    return key;
  }

  // The reader page lists only its first image; the rest come from a manifest
  // route whose name and parameters sit encrypted in the page props.
  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const url = `${DOMAIN}/manga/${mangaId}/${chapterId}/`;
    const html = await this.fetch(url);
    const props = this.props<ReaderProps>(html);
    const id = props.chapter?.id;
    const token = props.reader?.x;

    if (typeof id !== "number" || !token) {
      throw new Error(`The reader page for ${chapterId} carried no reader token.`);
    }

    const config = readerConfig(token, id, await this.readerKey(appScriptUrl(html)));
    const body = await this.fetch(manifestUrl(config, id, props.series?.slug ?? mangaId), {
      accept: "application/json",
      referer: url,
    });
    const pages = manifestPages(body, config, id);

    if (pages.length === 0) {
      throw new Error(`No pages were listed for ${chapterId}.`);
    }

    return App.createChapterDetails({ id: chapterId, mangaId, pages });
  }
}
