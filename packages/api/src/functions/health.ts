import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

const HEALTH_CHECK_STARTED_EVENT = "health_check_started";
const HEALTH_CHECK_COMPLETED_EVENT = "health_check_completed";

export const handler = (event: APIGatewayProxyEventV2, _context: Context) => {
  console.info({
    eventName: HEALTH_CHECK_STARTED_EVENT,
    method: event.requestContext.http.method,
    path: event.requestContext.http.path,
  });

  const response = {
    body: JSON.stringify({
      status: "ok",
    }),
    statusCode: 200,
  };

  console.info({
    eventName: HEALTH_CHECK_COMPLETED_EVENT,
    method: event.requestContext.http.method,
    path: event.requestContext.http.path,
    statusCode: response.statusCode,
  });

  return response;
};
