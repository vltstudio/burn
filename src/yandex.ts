import type { SpotifyImportProgress, SpotifyImportResult } from "./types";

export interface YandexFile {
  name: string;
  text: string;
}

export interface YandexTrack {
  title: string;
  artists: string[];
  seconds: number | null;
}

export interface YandexCollection {
  id: string;
  name: string;
  tracks: YandexTrack[];
  skipped: number;
}

export interface YandexPreview {
  collections: YandexCollection[];
  warnings: string[];
}

export interface YandexProgress extends SpotifyImportProgress {
  collectionName: string;
  collectionIndex: number;
  collectionTotal: number;
}

export interface YandexImportResult {
  id: string;
  name: string;
  skipped: number;
  report: SpotifyImportResult | null;
  error: string | null;
}
