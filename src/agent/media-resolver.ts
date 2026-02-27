import { extname } from "path";
import { readFile } from "fs/promises";
import { logger } from "../logger.js";

type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_MIMES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function resolveMedia(
  mediaPaths: string[],
  textContent: string,
): Promise<MessagePart[]> {
  const images: string[] = [];
  const files: string[] = [];

  for (const p of mediaPaths) {
    const ext = extname(p).toLowerCase();
    if (ext in IMAGE_MIMES) images.push(p);
    else files.push(p);
  }

  const labels = [
    ...images.map((p) => `[Image: ${p}]`),
    ...files.map((p) => `[File: ${p}]`),
  ];

  const parts: MessagePart[] = [];
  parts.push({
    type: "text",
    text: `${labels.join("\n")}${textContent ? `\n${textContent}` : ""}`,
  });

  for (const filePath of images) {
    try {
      const buffer = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      parts.push({
        type: "image",
        data: buffer.toString("base64"),
        mimeType: IMAGE_MIMES[ext],
      });
    } catch (e) {
      logger.error("agent", `failed to read media file: ${filePath}`, e);
    }
  }

  return parts;
}
