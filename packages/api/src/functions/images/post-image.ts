// oxlint-disable no-control-regex
import { randomUUIDv7 } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { z } from "zod";

import { client } from "../../lib/s3.js";

const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const postImageBodySchema = z.object({
  contentType: z.enum(MIME_TYPES),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // Reject "." and "..", path separators ("/" and "\"), and control characters.
    .regex(/^(?!\.{1,2}$)[^/\\\u0000-\u001F\u007F]+$/u, "Invalid filename"),
});

const envSchema = z.object({
  IMAGES_BUCKET_NAME: z.string().trim().nonempty(),
});

const buildObjectKey = (imageId: string, filename: string) =>
  `${imageId}/${filename}`;

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context
) => {
  let body: unknown;

  const envResult = envSchema.safeParse(process.env);

  if (!envResult.success) {
    console.error("Invalid Lambda configuration", {
      issues: envResult.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });

    return {
      body: JSON.stringify({
        message: "Internal Server Error",
      }),
      statusCode: 500,
    };
  }

  const { IMAGES_BUCKET_NAME } = envResult.data;

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

  try {
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: IMAGES_BUCKET_NAME,
        ContentType: data.contentType,
        Key: objectKey,
      }),
      {
        // expire in 10 minutes (in seconds)
        expiresIn: 60 * 10,
        signableHeaders: new Set(["content-type"]),
      }
    );

    return {
      body: JSON.stringify({
        contentType: data.contentType,
        filename: data.filename,
        imageId,
        objectKey,
        uploadUrl,
      }),
      statusCode: 200,
    };
  } catch (error: unknown) {
    console.error("Signed URL error", error);

    return {
      body: JSON.stringify({
        message: "Internal Server Error",
      }),
      statusCode: 500,
    };
  }
};
