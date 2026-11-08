// The composer's attached images, per chat, held in memory. The text draft lives
// in storage under `draft.<chatId>` and survives a tab switch; images did not,
// because they were the composer's own state and the composer remounts per chat
// (App.tsx keys it by chatId). They are megabytes of base64, so they do not
// belong in localStorage: a small map is enough, and it is dropped on reload.
//
// A few chats at most are kept: the images of a chat nobody returns to are dead
// weight, and each one can be several megabytes.
import type { PendingImage } from "./images.js";

/** How many chats keep their draft images in memory. */
const CHATS = 4;

/** chatId → its images, least recently stored first. */
const byChat = new Map<string, PendingImage[]>();

/** The images the composer had for this chat, as they were left. */
export function draftImages(chatId: string): PendingImage[] {
  const images = byChat.get(chatId);
  if (!images) return [];
  // Touch: this chat is the most recently used.
  byChat.delete(chatId);
  byChat.set(chatId, images);
  return images;
}

/** Keep this chat's images for when its composer comes back; empty forgets them. */
export function saveDraftImages(chatId: string, images: PendingImage[]): void {
  if (images.length === 0) {
    byChat.delete(chatId);
    return;
  }
  byChat.delete(chatId);
  byChat.set(chatId, images);
  while (byChat.size > CHATS) {
    const oldest = byChat.keys().next().value;
    if (oldest === undefined) break;
    byChat.delete(oldest);
  }
}

/** Drop everything (tests, and a chat that was closed for good). */
export function forgetDraftImages(): void {
  byChat.clear();
}
