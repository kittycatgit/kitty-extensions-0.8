/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 kittycatgit */

export type Option = { id: string; label: string };

export type SearchMetadata = {
  offset?: number;
  page?: number;
  sort?: string;
  genres?: string[];
  hideNSFW?: boolean;
  hideYaoi?: boolean;
  hideLicensed?: boolean;
};

// `genres` and `alternativeTitle` are delimited strings, not lists: comma and
// semicolon respectively.
export type ApiManga = {
  id: number;
  title: string;
  slug: string;
  mainSlug?: string | null;
  alternativeTitle?: string | null;
  status?: string | null;
  image?: string | null;
  latestChapter?: number | null;
  genres?: string | null;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  rank?: number | null;
  isWebtoon?: boolean | null;
  isYaoi?: boolean | null;
  isPorn?: boolean | null;
  isSoftPorn?: boolean | null;
  isSafe?: boolean | null;
  isLicensed?: boolean | null;
  createdDate?: string | null;
  updatedDate?: string | null;
  chapters?: ApiChapter[] | null;
};

export type ApiChapter = {
  id: number;
  number: number;
  title?: string | null;
  slug?: string | null;
  date?: string | null;
};

// `pages` is a JSON string, not an object, and arrives encrypted.
export type ApiChapterFull = ApiChapter & {
  mangaID?: number | null;
  pages?: string | null;
  s?: string | null;
};

export type ApiGenre = {
  id: number;
  slug: string;
  title: string;
  count?: number | null;
  group?: string | null;
};

export type ApiSearch = { rows?: ApiManga[] | null; count?: number | null };

// The schema exposes other sources, but this is the only one the site queries.
export const SOURCE = "m01";

export const DOMAIN = "https://mangahub.io";
export const HOST = "mangahub.io";

// api.mghcdn.com answers third parties with "This app does not have permission to
// access the website content" since November 2026; the site now talks to its own
// origin, which is what the app has to do as well.
export const API_URL = `${DOMAIN}/graphql`;
export const CHAPTER_CRYPTO_URL = `${DOMAIN}/api/chapter-crypto`;
export const COVER_CDN = "https://thumb.mghcdn.com";
export const PAGE_CDN = "https://imgx.mghcdn.com";

// An empty cover fails the whole rail, not just one card. This is a real URL
// holding no image, so the app falls through to its own placeholder.
export const FALLBACK_COVER = `${COVER_CDN}/no-cover.jpg`;

export const LIST_FIELDS =
  "id,rank,title,slug,status,image,latestChapter,genres,author,isSafe,isLicensed,updatedDate";

// `Status` is left out: the schema accepts it but the resolver ignores it and
// returns the same rows whatever you pass.
export const SORT_OPTIONS: Option[] = [
  { id: "POPULAR", label: "Popular" },
  { id: "LATEST", label: "Latest" },
  { id: "NEW", label: "Newest" },
  { id: "COMPLETED", label: "Completed" },
  { id: "ALPHABET", label: "A – Z" },
];

export const DEFAULT_SORT = "POPULAR";

// The search filter has no sorting control of its own in 0.8, so sort and the
// API's exclusions are offered as tags.
export const EXCLUDE_OPTIONS: Option[] = [
  { id: "hideNSFW", label: "Hide NSFW" },
  { id: "hideYaoi", label: "Hide Yaoi" },
  { id: "hideLicensed", label: "Hide licensed" },
];

export const FILTER_SECTIONS: { id: string; label: string; options: Option[] }[] = [
  { id: "sort", label: "Sort", options: SORT_OPTIONS },
  { id: "exclude", label: "Exclude", options: EXCLUDE_OPTIONS },
];

export const PAGE_SIZE = 30;
export const LATEST_PAGE_SIZE = 30;

export const GENRE_CACHE_TTL = 24 * 60 * 60 * 1000;
export const GENRE_STATE_KEY = "mangahub.genres";
export const SESSION_STATE_KEY = "mangahub.session";

export const POPULAR_UPDATES_SECTION_ID = "popular-updates";
export const LATEST_SECTION_ID = "latest-updates";

export const SORTED_SECTIONS: { id: string; title: string; mod: string }[] = [
  { id: "popular", title: "Popular", mod: "POPULAR" },
  { id: "new", title: "New", mod: "NEW" },
  { id: "completed", title: "Completed", mod: "COMPLETED" },
];

export const STATUS_LABELS: Record<string, string> = {
  ongoing: "Ongoing",
  completed: "Completed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  hiatus: "Hiatus",
};

// Fallback for when the live `genres` query fails, and the name-to-slug map the
// detail parser needs to build valid tag ids.
export const GENRES: Option[] = [
  { id: "action", label: "Action" },
  { id: "adventure", label: "Adventure" },
  { id: "comedy", label: "Comedy" },
  { id: "adult", label: "Adult" },
  { id: "drama", label: "Drama" },
  { id: "historical", label: "Historical" },
  { id: "martial-arts", label: "Martial Arts" },
  { id: "romance", label: "Romance" },
  { id: "ecchi", label: "Ecchi" },
  { id: "supernatural", label: "Supernatural" },
  { id: "webtoons", label: "Webtoons" },
  { id: "manhwa", label: "Manhwa" },
  { id: "fantasy", label: "Fantasy" },
  { id: "harem", label: "Harem" },
  { id: "shounen", label: "Shounen" },
  { id: "manhua", label: "Manhua" },
  { id: "mature", label: "Mature" },
  { id: "seinen", label: "Seinen" },
  { id: "sports", label: "Sports" },
  { id: "school-life", label: "School Life" },
  { id: "smut", label: "Smut" },
  { id: "mystery", label: "Mystery" },
  { id: "psychological", label: "Psychological" },
  { id: "shounen-ai", label: "Shounen ai" },
  { id: "slice-of-life", label: "Slice of life" },
  { id: "shoujo-ai", label: "Shoujo ai" },
  { id: "cooking", label: "Cooking" },
  { id: "horror", label: "Horror" },
  { id: "tragedy", label: "Tragedy" },
  { id: "doujinshi", label: "Doujinshi" },
  { id: "sci-fi", label: "Sci-Fi" },
  { id: "yuri", label: "Yuri" },
  { id: "yaoi", label: "Yaoi" },
  { id: "shoujo", label: "Shoujo" },
  { id: "gender-bender", label: "Gender bender" },
  { id: "josei", label: "Josei" },
  { id: "mecha", label: "Mecha" },
  { id: "medical", label: "Medical" },
  { id: "magic", label: "Magic" },
  { id: "4-koma", label: "4-Koma" },
  { id: "music", label: "Music" },
  { id: "webtoon", label: "Webtoon" },
  { id: "isekai", label: "Isekai" },
  { id: "game", label: "Game" },
  { id: "award-winning", label: "Award Winning" },
  { id: "oneshot", label: "Oneshot" },
  { id: "demons", label: "Demons" },
  { id: "military", label: "Military" },
  { id: "police", label: "Police" },
  { id: "super-power", label: "Super Power" },
  { id: "food", label: "Food" },
  { id: "kids", label: "Kids" },
  { id: "magical-girls", label: "Magical Girls" },
  { id: "wuxia", label: "Wuxia" },
  { id: "superhero", label: "Superhero" },
  { id: "thriller", label: "Thriller" },
  { id: "crime", label: "Crime" },
  { id: "philosophical", label: "Philosophical" },
  { id: "adaptation", label: "Adaptation" },
  { id: "full-color", label: "Full Color" },
  { id: "crossdressing", label: "Crossdressing" },
  { id: "reincarnation", label: "Reincarnation" },
  { id: "manga", label: "Manga" },
  { id: "cartoon", label: "Cartoon" },
  { id: "survival", label: "Survival" },
  { id: "comic", label: "Comic" },
  { id: "english", label: "English" },
  { id: "harlequin", label: "Harlequin" },
  { id: "time-travel", label: "Time Travel" },
  { id: "traditional-games", label: "Traditional Games" },
  { id: "reverse-harem", label: "Reverse Harem" },
  { id: "animals", label: "Animals" },
  { id: "aliens", label: "Aliens" },
  { id: "loli", label: "Loli" },
  { id: "video-games", label: "Video Games" },
  { id: "monsters", label: "Monsters" },
  { id: "office-workers", label: "Office Workers" },
  { id: "system", label: "System" },
  { id: "villainess", label: "Villainess" },
  { id: "zombies", label: "Zombies" },
  { id: "vampires", label: "Vampires" },
  { id: "violence", label: "Violence" },
  { id: "monster-girls", label: "Monster Girls" },
  { id: "anthology", label: "Anthology" },
  { id: "ghosts", label: "Ghosts" },
  { id: "delinquents", label: "Delinquents" },
  { id: "post-apocalyptic", label: "Post-Apocalyptic" },
  { id: "xianxia", label: "Xianxia" },
  { id: "xuanhuan", label: "Xuanhuan" },
  { id: "r-18", label: "R-18" },
  { id: "cultivation", label: "Cultivation" },
  { id: "rebirth", label: "Rebirth" },
  { id: "gore", label: "Gore" },
  { id: "russian", label: "Russian" },
  { id: "samurai", label: "Samurai" },
  { id: "ninja", label: "Ninja" },
  { id: "revenge", label: "Revenge" },
  { id: "cheat-systems", label: "Cheat Systems" },
  { id: "dungeons", label: "Dungeons" },
  { id: "overpowered", label: "Overpowered" },
  { id: "royal-family", label: "Royal family" },
  { id: "long-strip", label: "Long Strip" },
  { id: "shota", label: "Shota" },
  { id: "web-comic", label: "Web Comic" },
  { id: "virtual-reality", label: "Virtual Reality" },
  { id: "genderswap", label: "Genderswap" },
  { id: "suggestive", label: "Suggestive" },
  { id: "mafia", label: "Mafia" },
  { id: "murim", label: "Murim" },
  { id: "returner", label: "Returner" },
  { id: "official-colored", label: "Official colored" },
  { id: "sexual-violence", label: "Sexual Violence" },
  { id: "gyaru", label: "Gyaru" },
  { id: "erotica", label: "Erotica" },
  { id: "pornographic", label: "Pornographic" },
  { id: "blood", label: "Blood" },
  { id: "fighting", label: "Fighting" },
  { id: "girls-love", label: "Girls' love" },
  { id: "regression", label: "Regression" },
  { id: "tower-climbing", label: "Tower Climbing" },
  { id: "fan-colored", label: "Fan Colored" },
  { id: "self-published", label: "Self-Published" },
  { id: "safe", label: "Safe" },
  { id: "boys-love", label: "Boys' Love" },
  { id: "incest", label: "Incest" },
  { id: "weak-to-strong", label: "Weak-to-Strong" },
  { id: "ruthless-protagonist", label: "Ruthless Protagonist" },
  { id: "smart-mc", label: "Smart MC" },
  { id: "hunters", label: "Hunters" },
  { id: "mahjong", label: "Mahjong" },
  { id: "hentai", label: "Hentai" },
  { id: "maga", label: "Maga" },
];
