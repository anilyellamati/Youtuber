import { invoke, listen } from "../lib/platform";
import type { Channel } from "../lib/appStore";

export const ytLogin = (clientId: string, clientSecret: string) =>
  invoke<Channel>("yt_login", { clientId: clientId || null, clientSecret: clientSecret || null });

export const ytStatus = () => invoke<Channel | null>("yt_status");
export const ytLogout = () => invoke<void>("yt_logout");

export interface UploadRequest {
  path: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: "public" | "unlisted" | "private";
  publishAt?: string; // ISO time; requires privacy=private
  madeForKids: boolean;
  language: string;
  notifySubscribers: boolean;
  thumbnail?: string;
}

export interface UploadProgress {
  id: string;
  sent: number;
  total: number;
  stage: string;
}

export async function ytUpload(id: string, r: UploadRequest, onProgress: (p: UploadProgress) => void): Promise<string> {
  const off = await listen<UploadProgress>("youtube://progress", (p) => p.id === id && onProgress(p));
  try {
    const metadata = {
      snippet: {
        title: r.title,
        description: r.description,
        tags: r.tags,
        categoryId: r.categoryId,
        defaultLanguage: r.language,
        defaultAudioLanguage: r.language,
      },
      status: {
        privacyStatus: r.publishAt ? "private" : r.privacy,
        ...(r.publishAt ? { publishAt: r.publishAt } : {}),
        selfDeclaredMadeForKids: r.madeForKids,
        embeddable: true,
        license: "youtube",
      },
    };
    return await invoke<string>("yt_upload", { id, path: r.path, metadata, thumbnail: r.thumbnail ?? null, notify: r.notifySubscribers });
  } finally {
    off();
  }
}
