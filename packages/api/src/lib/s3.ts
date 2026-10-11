import { S3Client } from "@aws-sdk/client-s3";

export const client = new S3Client({
  // Don't create a checksum when the body is empty, we need this since we use presigned URL's for S3 and don't send the bytes through Lambda
  requestChecksumCalculation: "WHEN_REQUIRED",
});
