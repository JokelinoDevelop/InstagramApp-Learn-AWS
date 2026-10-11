// oxlint-disable no-control-regex
import { randomUUIDv7 } from "node:crypto";

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { z } from "zod";

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const postImageBodySchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // Reject "." and "..", path separators ("/" and "\"), and control characters.
    .regex(/^(?!\.{1,2}$)[^/\\\u0000-\u001F\u007F]+$/u, "Invalid filename"),
  mimeType: z.enum(MIME_TYPES),
});

const buildObjectKey = (imageId: string, filename: string) =>
  `${imageId}/${filename}`;

export const handler = (event: APIGatewayProxyEventV2, _context: Context) => {
  let body: unknown;

  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      body: JSON.stringify({
        message: "Invalid JSON body",
      }),
      statusCode: 400,
    };
  }

  const result = postImageBodySchema.safeParse(body);

  if (!result.success) {
    return {
      body: JSON.stringify({
        message: "Invalid request body",
      }),
      statusCode: 400,
    };
  }

  const { data } = result;

  const imageId = randomUUIDv7();

  const objectKey = buildObjectKey(imageId, data.filename);

  return {
    body: JSON.stringify({
      filename: data.filename,
      imageId,
      mimeType: data.mimeType,
      objectKey,
    }),
    statusCode: 200,
  };
};
