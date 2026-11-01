/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

// The site hops domains; kagane.org is the fixed mirrors page that lists the
// live one. DEFAULT_DOMAIN is only what settings show before the first resolve.
export const MIRRORS_URL = "https://kagane.org/";
export const DEFAULT_DOMAIN = "https://kagane.moe";
export const DOMAIN_TTL_MS = 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 35;

export const DOMAIN_KEY = "kagane-domain";
export const DOMAIN_AT_KEY = "kagane-domain-at";
export const DOMAIN_OVERRIDE_KEY = "kagane-domain-override";
export const CHALLENGE_HOST_KEY = "kagane-challenge-host";
export const INTEGRITY_KEY = "kagane-integrity";
export const CONTENT_RATINGS_KEY = "kagane-content-ratings";
export const SHOW_PORNOGRAPHIC_KEY = "kagane-show-pornographic";
export const SHOW_DISTURBING_KEY = "kagane-show-disturbing";
export const SOURCE_DISPLAY_MODE_KEY = "kagane-source-display-mode";
export const EXCLUDED_GENRES_KEY = "kagane-excluded-genres";
export const CONTENT_LANGUAGES_KEY = "kagane-content-languages";
export const SHOW_SOURCE_KEY = "kagane-show-source";
export const TAG_MATCH_ALL_KEY = "kagane-tag-match-all";
export const HIDDEN_TAG_CATEGORIES_KEY = "kagane-hidden-tag-categories";
export const CUSTOM_HIDDEN_TAGS_KEY = "kagane-custom-hidden-tags";
export const TAGS_CACHE_KEY = "kagane-tags-cache";
export const TAGS_CACHE_DATE_KEY = "kagane-tags-cache-date";

// The API rejects anything else: "unknown variant, expected one of `Safe`,
// `FifteenPlus`, `EighteenPlus`".
export const AGE_RATINGS = [
  { id: "Safe", title: "Safe" },
  { id: "FifteenPlus", title: "15+" },
  { id: "EighteenPlus", title: "18+" },
] as const;

export const DEFAULT_RATINGS: string[] = ["Safe", "FifteenPlus"];

// Ratings stored by builds that predate the age_rating ladder.
export const LEGACY_RATINGS: Record<string, string> = {
  safe: "Safe",
  suggestive: "FifteenPlus",
  erotica: "EighteenPlus",
  pornographic: "EighteenPlus",
};

export const SOURCE_DISPLAY_MODES = [
  { id: "all", title: "Show All", types: ["Official", "Unofficial", "Mixed"] },
  { id: "official", title: "Official Sources Only", types: ["Official"] },
  { id: "scanlations", title: "Scanlations Only", types: ["Unofficial", "Mixed"] },
] as const;

export const LANGUAGES = [
  { id: "en", title: "English" },
  { id: "ja", title: "Japanese" },
  { id: "ko", title: "Korean" },
  { id: "zh-Hans", title: "Chinese Simplified" },
  { id: "zh-Hant", title: "Chinese Traditional" },
  { id: "es", title: "Spanish" },
  { id: "es-419", title: "Spanish (Latin America)" },
  { id: "fr", title: "French" },
  { id: "de", title: "German" },
  { id: "pt", title: "Portuguese" },
  { id: "pt-BR", title: "Portuguese (Brazil)" },
  { id: "ru", title: "Russian" },
  { id: "it", title: "Italian" },
  { id: "id", title: "Indonesian" },
  { id: "vi", title: "Vietnamese" },
  { id: "th", title: "Thai" },
  { id: "pl", title: "Polish" },
  { id: "hi", title: "Hindi" },
  { id: "ar", title: "Arabic" },
];

export const FORMATS = ["Manga", "Manhwa", "Manhua", "Comic", "Other"];

export const UPLOAD_STATUSES = [
  { id: "Ongoing", title: "Ongoing" },
  { id: "Completed", title: "Completed" },
  { id: "Abandoned", title: "Cancelled" },
  { id: "Hiatus", title: "Hiatus" },
];

// Ids stay free of the comma the API wants; every field here sorts descending.
export const SORT_FIELDS = [
  { id: "avg_views_today", title: "Popular Today" },
  { id: "avg_views_week", title: "Popular This Week" },
  { id: "avg_views_month", title: "Popular This Month" },
  { id: "avg_views", title: "Popular All Time" },
  { id: "updated_at", title: "Recently Updated" },
  { id: "created_at", title: "Recently Added" },
  { id: "rating", title: "Top Rated" },
  { id: "current_books", title: "Most Chapters" },
];

// "trending" is its own endpoint; the rest are sorts of the search endpoint,
// matching the rows the site's home page shows.
export const HOME_SECTIONS = [
  { id: "trending", title: "Trending This Week", sort: "" },
  { id: "popular_today", title: "Popular Today", sort: "avg_views_today,desc" },
  { id: "popular_week", title: "Popular This Week", sort: "avg_views_week,desc" },
  { id: "updated", title: "Recently Updated", sort: "updated_at,desc" },
  { id: "added", title: "Recently Added", sort: "created_at,desc" },
] as const;

export interface GenreDto {
  id: string;
  genre_name: string;
  genre_type?: string | null;
}

export interface SourceDto {
  source_id: string;
  source_type: string;
  title: string;
}

export interface TagDto {
  id: string;
  tag_name: string;
  status?: string | null;
}

export interface SearchBook {
  series_id: string;
  title: string;
  source_id?: string | null;
  current_books?: number | null;
  start_year?: number | null;
  cover_image_id?: string | null;
  latest_chapters?: Array<{ chapter_no?: string | null; created_at?: string | null }> | null;
}

export interface SearchDto {
  content?: SearchBook[];
  last?: boolean;
  total_elements?: number;
}

export interface TrendingDto {
  items?: Array<{
    series?: {
      series_id: string;
      title: string;
      cover_image_id?: string | null;
      current_books?: number | null;
    } | null;
  }>;
}

export interface DetailsDto {
  title: string;
  description?: string | null;
  publication_status?: string | null;
  upload_status?: string | null;
  format?: string | null;
  age_rating?: string | null;
  is_pornographic?: boolean | null;
  source_id?: string | null;
  main_cover_id?: string | null;
  series_staff?: Array<{ name: string; role: string }>;
  genres?: Array<{ genre_id: string; genre_name: string }>;
  tags?: Array<{ tag_id: string; tag_name: string }>;
  series_alternate_titles?: Array<{ title: string }>;
  series_covers?: Array<{ cover_id: string; image_id: string; is_main?: boolean }>;
}

// Column names come with the payload; each book is a row in that order.
export interface BookIndexDto {
  count?: number;
  fields: string[];
  groups?: Array<{ title: string }>;
  books?: unknown[][] | null;
}

export interface ChallengeDto {
  access_token: string;
  cache_url: string;
  manifest?: { pages?: Array<{ page_no: number; page_id: string; ext?: string | null }> } | null;
}

export interface IntegrityDto {
  token: string;
  exp: number;
}
