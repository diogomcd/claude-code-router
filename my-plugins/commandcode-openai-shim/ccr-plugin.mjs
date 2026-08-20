import { createRequestHandler } from "./src/server.mjs";

export const ROUTE_PREFIX = "/commandcode";

function stripRoutePrefix(url) {
  if (url.startsWith(ROUTE_PREFIX)) {
    const rest = url.slice(ROUTE_PREFIX.length);
    return rest === "" ? "/" : rest;
  }
  return url;
}

export function setup(context) {
  const config = context?.pluginConfig ?? {};
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error("commandcode-shim plugin requires apiKey in its plugin config");
  }

  const options = { apiKey };
  if (config.baseUrl !== undefined) options.baseUrl = config.baseUrl;
  if (config.cliVersion !== undefined) options.cliVersion = config.cliVersion;
  if (config.cliEnvironment !== undefined) options.cliEnvironment = config.cliEnvironment;

  const shimHandler = createRequestHandler(options);

  const handler = async (request, response) => {
    request.url = stripRoutePrefix(request.url ?? "/");
    await shimHandler(request, response);
  };

  return {
    gatewayRoutes: [
      {
        id: "commandcode-shim",
        pathPrefix: ROUTE_PREFIX,
        methods: ["GET", "POST"],
        auth: "none",
        handler,
      },
    ],
  };
}
