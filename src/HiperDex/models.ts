/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

import { ContentRating } from "@paperback/types";

export const DOMAIN = "https://hiperdex.tv";

// An empty image fails the whole row it is in, so point at a real URL that
// serves no image and let the app draw its own placeholder.
export const FALLBACK_COVER = `${DOMAIN}/_no-cover.png`;

export type Option = { id: string; label: string };

export type SearchMetadata = {
  offset: number;
  sort: string;
  genres?: string[];
  type?: string;
  status?: string;
  contentRating?: string;
};

export type ApiSeries = {
  id: number;
  slug: string;
  title: string;
  // A JSON-encoded array on the detail route, but a real array on search hits.
  alternativeTitles?: string | string[] | null;
  synopsis?: string | null;
  coverUrl?: string | null;
  type?: string | null;
  status?: string | null;
  contentRating?: string | null;
  year?: number | null;
  score?: number | null;
  scoredBy?: number | null;
  views?: number | null;
  favorites?: number | null;
  genres?: string[] | null;
  authors?: string[] | null;
  artists?: string[] | null;
  updatedAt?: string | null;
};

export type ApiChapter = {
  id: number;
  seriesId: number;
  number: number;
  volume?: number | null;
  title?: string | null;
  language?: string | null;
  pagesCount?: number | null;
  views?: number | null;
  createdAt?: string | null;
};

export type ApiPage = {
  pageOrder: number;
  webpUrl?: string | null;
  avifUrl?: string | null;
};

export type ApiTrendingItem = ApiSeries & {
  latestChapter?: { number: number; createdAt?: string | null } | null;
};

export type ApiLatestItem = {
  seriesId: number;
  seriesSlug: string;
  seriesTitle: string;
  seriesCoverUrl?: string | null;
  seriesStatus?: string | null;
  score?: number | null;
  chapters?: { id: number; number: number; title?: string | null; createdAt?: string | null }[];
};

export type ApiGenre = { id: number; name: string; slug: string };

// The API rejects any sort id outside this list with a validation error.
export const SORT_OPTIONS: Option[] = [
  { id: "recent", label: "Recently Updated" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "popular", label: "Most Popular" },
  { id: "score", label: "Highest Rated" },
  { id: "alphabetical", label: "A – Z" },
  { id: "relevance", label: "Relevance" },
];

export const DEFAULT_SORT = "recent";

// search.query caps limit at 100; recommendations.trending rejects anything over 20.
export const PAGE_SIZE = 30;
export const TRENDING_PAGE_SIZE = 20;
export const LATEST_PAGE_SIZE = 40;

// Widest rating the API will return; the app filters per item afterwards.
export const MAX_RATING = "pornographic";

// Search hits carry no chapter information, so counts are fetched separately
// for a whole page at a time and cached.
export const CHAPTER_COUNT_TTL_MS = 12 * 60 * 60_000;
export const CHAPTER_COUNT_MAX = 400;
export const CHAPTER_COUNT_KEY = "hiperdex.chapterCounts";

export const GENRE_CACHE_TTL = 24 * 60 * 60_000;
export const GENRE_STATE_KEY = "hiperdex.genres";
export const SESSION_STATE_KEY = "hiperdex.session";

// The reader route 403s without this header. The site builds the name and
// value at runtime, so they can only be pinned here.
export const READER_HEADER = "x-cfg-auth";
export const READER_TOKEN = "yceqt7qgu004";

export const TYPE_OPTIONS: Option[] = [
  { id: "manhwa", label: "Manhwa" },
  { id: "manga", label: "Manga" },
  { id: "manhua", label: "Manhua" },
];

export const STATUS_OPTIONS: Option[] = [
  { id: "releasing", label: "Releasing" },
  { id: "ongoing", label: "Ongoing" },
  { id: "completed", label: "Completed" },
  { id: "hiatus", label: "Hiatus" },
  { id: "cancelled", label: "Cancelled" },
];

export const CONTENT_RATING_OPTIONS: Option[] = [
  { id: "safe", label: "Safe" },
  { id: "suggestive", label: "Suggestive" },
  { id: "erotica", label: "Erotica" },
  { id: "pornographic", label: "Pornographic" },
];

// Non-genre filters carry a prefix so one includedTags list can hold them all;
// genre ids stay bare slugs so detail-page tags search directly.
export const FILTER_SECTIONS: { id: string; label: string; options: Option[] }[] = [
  { id: "type", label: "Type", options: TYPE_OPTIONS },
  { id: "status", label: "Status", options: STATUS_OPTIONS },
  { id: "rating", label: "Content rating", options: CONTENT_RATING_OPTIONS },
  { id: "sort", label: "Sort", options: SORT_OPTIONS },
];

export const TRENDING_SECTIONS: { id: string; title: string; period: string }[] = [
  { id: "trending-day", title: "Trending Today", period: "day" },
  { id: "trending-week", title: "Trending This Week", period: "week" },
  { id: "trending-month", title: "Trending This Month", period: "month" },
];

export const LATEST_SECTION_ID = "latest-chapters";

export const STATUS_LABELS: Record<string, string> = {
  releasing: "Ongoing",
  ongoing: "Ongoing",
  completed: "Completed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  hiatus: "Hiatus",
};

export const CONTENT_RATINGS: Record<string, ContentRating> = {
  safe: ContentRating.EVERYONE,
  suggestive: ContentRating.MATURE,
  erotica: ContentRating.ADULT,
  pornographic: ContentRating.ADULT,
};

// Used when the live genre list can't be fetched, and as the name-to-slug map
// the detail parser needs to build valid tag ids.
export const GENRES: Option[] = [
  { id: "4-koma", label: "4-Koma" },
  { id: "action", label: "Action" },
  { id: "adaptation", label: "Adaptation" },
  { id: "adult", label: "Adult" },
  { id: "adventure", label: "Adventure" },
  { id: "age-gap", label: "Age Gap" },
  { id: "aliens", label: "Aliens" },
  { id: "ancient-korea", label: "Ancient Korea" },
  { id: "animals", label: "Animals" },
  { id: "anthology", label: "Anthology" },
  { id: "award-winning", label: "Award Winning" },
  { id: "campus", label: "Campus" },
  { id: "childhood-friends", label: "Childhood Friends" },
  { id: "comedy", label: "Comedy" },
  { id: "cooking", label: "Cooking" },
  { id: "crime", label: "Crime" },
  { id: "crossdressing", label: "Crossdressing" },
  { id: "dance", label: "Dance" },
  { id: "delinquents", label: "Delinquents" },
  { id: "demons", label: "Demons" },
  { id: "doujinshi", label: "Doujinshi" },
  { id: "drama", label: "Drama" },
  { id: "ecchi", label: "Ecchi" },
  { id: "escolar", label: "Escolar" },
  { id: "fantasy", label: "Fantasy" },
  { id: "fellatio-blowjob", label: "Fellatio/Blowjob" },
  { id: "fetish", label: "Fetish" },
  { id: "full-color", label: "Full Color" },
  { id: "furry", label: "Furry" },
  { id: "gender-bender", label: "Gender Bender" },
  { id: "genderswap", label: "Genderswap" },
  { id: "ghosts", label: "Ghosts" },
  { id: "girls-love", label: "Girls' Love" },
  { id: "gore", label: "Gore" },
  { id: "guideverse", label: "Guideverse" },
  { id: "gyaru", label: "Gyaru" },
  { id: "hair-color-change", label: "Hair Color Change" },
  { id: "harem", label: "Harem" },
  { id: "hentai", label: "Hentai" },
  { id: "heroes", label: "Heroes" },
  { id: "historical", label: "Historical" },
  { id: "horror", label: "Horror" },
  { id: "human-nonhuman-relationship", label: "Human-Nonhuman Relationship" },
  { id: "incest", label: "Incest" },
  { id: "isekai", label: "Isekai" },
  { id: "josei", label: "Josei" },
  { id: "korea", label: "Korea" },
  { id: "korean-ambience", label: "Korean Ambience" },
  { id: "korean-bl", label: "Korean BL" },
  { id: "loli", label: "Loli" },
  { id: "long-strip", label: "Long Strip" },
  { id: "long-haired-male-character-s", label: "Long-Haired Male Character/s" },
  { id: "long-haired-male-lead", label: "Long-Haired Male Lead" },
  { id: "love-triangle-s", label: "Love Triangle/s" },
  { id: "low-fantasy", label: "Low Fantasy" },
  { id: "maduro", label: "Maduro" },
  { id: "mafia", label: "Mafia" },
  { id: "magic", label: "Magic" },
  { id: "male-protagonist", label: "Male Protagonist" },
  { id: "manga", label: "Manga" },
  { id: "martial-arts", label: "Martial Arts" },
  { id: "masculine-uke", label: "Masculine Uke" },
  { id: "mature", label: "Mature" },
  { id: "mecha", label: "Mecha" },
  { id: "medical", label: "Medical" },
  { id: "military", label: "Military" },
  { id: "monster-girls", label: "Monster Girls" },
  { id: "monsters", label: "Monsters" },
  { id: "monsters-invade-earth", label: "Monsters Invade Earth" },
  { id: "murim", label: "Murim" },
  { id: "music", label: "Music" },
  { id: "mystery", label: "Mystery" },
  { id: "nameverse", label: "Nameverse" },
  { id: "ninja", label: "Ninja" },
  { id: "office-workers", label: "Office Workers" },
  { id: "oneshot", label: "Oneshot" },
  { id: "orphan-female-lead", label: "Orphan Female Lead" },
  { id: "philosophical", label: "Philosophical" },
  { id: "police", label: "Police" },
  { id: "post-apocalyptic", label: "Post-Apocalyptic" },
  { id: "psychological", label: "Psychological" },
  { id: "red-haired-male-lead", label: "Red-Haired Male Lead" },
  { id: "red-haired-seme", label: "Red-Haired Seme" },
  { id: "regression", label: "Regression" },
  { id: "reincarnation", label: "Reincarnation" },
  { id: "revenge", label: "Revenge" },
  { id: "romance", label: "Romance" },
  { id: "samurai", label: "Samurai" },
  { id: "school-life", label: "School Life" },
  { id: "sci-fi", label: "Sci-fi" },
  { id: "secret-relationship", label: "Secret Relationship" },
  { id: "seinen", label: "Seinen" },
  { id: "self-published", label: "Self-Published" },
  { id: "sexual-violence", label: "Sexual Violence" },
  { id: "shota", label: "Shota" },
  { id: "shotacon", label: "Shotacon" },
  { id: "shoujo", label: "Shoujo" },
  { id: "shoujo-ai", label: "Shoujo Ai" },
  { id: "shounen", label: "Shounen" },
  { id: "size-difference", label: "Size Difference" },
  { id: "slice-of-life", label: "Slice of Life" },
  { id: "smut", label: "Smut" },
  { id: "sports", label: "Sports" },
  { id: "superhero", label: "Superhero" },
  { id: "supernatural", label: "Supernatural" },
  { id: "survival", label: "Survival" },
  { id: "suspense", label: "Suspense" },
  { id: "thriller", label: "Thriller" },
  { id: "time-travel", label: "Time Travel" },
  { id: "tower", label: "Tower" },
  { id: "tragedy", label: "Tragedy" },
  { id: "uncensored", label: "Uncensored" },
  { id: "vampires", label: "Vampires" },
  { id: "video-games", label: "Video Games" },
  { id: "villainess", label: "Villainess" },
  { id: "violence", label: "Violence" },
  { id: "virtual-reality", label: "Virtual Reality" },
  { id: "web-comic", label: "Web Comic" },
  { id: "webtoon", label: "Webtoon" },
  { id: "wuxia", label: "Wuxia" },
  { id: "yaoi", label: "Yaoi" },
  { id: "yuri", label: "Yuri" },
  { id: "zombies", label: "Zombies" },
];
