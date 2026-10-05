// oxlint-disable anti-slop/no-unknown-parameters
import type { Context } from "aws-lambda";

export const handler = (_event: unknown, context: Context) => {
  console.log("Health check event:", _event, "\n");
  console.log("Health check context:", context);

  return {
    status: "ok",
  };
};
