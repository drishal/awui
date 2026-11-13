// A custom harness's mark: center-cropped square (SVGs fitted), bounded to the
// exact 64 x 64 PNG the server accepts. SVGs decode into a canvas under awui's
// CSP (no resource fetch), so only raster reaches the server. createImageBitmap
// cannot decode SVG in Chromium, hence an Image for that one shape.

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const OUT = 64;

async function decodedSvg(file: File): Promise<HTMLImageElement> {
  // Chromium rejects SVG blob-image decoding but honors a data URL. This is a
  // short-lived decode source, not an asset or uploaded markup.
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const image = document.createElement("img");
  image.src = `data:image/svg+xml;base64,${btoa(binary)}`;
  await image.decode();
  return image;
}

export async function harnessIconPng(file: File): Promise<Blob> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose an image up to 8 MB. It is stored as a 64 × 64 PNG.");
  let source: ImageBitmap | HTMLImageElement | null = null;
  try {
    const svg = file.type === "image/svg+xml";
    source = svg ? await decodedSvg(file) : await createImageBitmap(file, { resizeWidth: 1024, resizeQuality: "high" });
    const width: number = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height: number = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (Math.min(width, height) < 16) throw new Error("That image is too small; its shorter edge needs at least 16 pixels.");
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot prepare a harness image.");
    if (svg) {
      const fit = Math.min(OUT / width, OUT / height);
      ctx.drawImage(source, (OUT - width * fit) / 2, (OUT - height * fit) / 2, width * fit, height * fit);
    } else {
      const side = Math.min(width, height);
      ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, OUT, OUT);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The browser could not encode that harness image; try a PNG or JPEG.");
    return blob;
  } catch (e) {
    throw new Error(`Could not prepare that icon: ${e instanceof Error ? e.message : "the image cannot be read"}`);
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}

export type HarnessIconResult = { icon: string | null };

/** Removing is separate: a failed upload must not erase a working mark. */
export async function removeHarnessIcon(id: string): Promise<HarnessIconResult> {
  return requestHarnessIcon(id, "DELETE");
}

async function requestHarnessIcon(id: string, method: string, body?: Blob): Promise<HarnessIconResult> {
  const res = await fetch(`/api/settings/harness-marks/${encodeURIComponent(id)}`, { method, credentials: "same-origin", body: body ?? null });
  const data = (await res.json().catch(() => ({}))) as HarnessIconResult & { error?: string };
  if (!res.ok || typeof data.icon === "undefined") throw new Error(data.error ?? `Could not ${method === "DELETE" ? "remove" : "save"} the agent mark (${res.status})`);
  return data;
}

export async function uploadHarnessIcon(id: string, file: File): Promise<HarnessIconResult> {
  const png = await harnessIconPng(file);
  return requestHarnessIcon(id, "PUT", png);
}
