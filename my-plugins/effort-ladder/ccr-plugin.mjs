const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const EFFORT_BODY_PATHS = [
  ["output_config", "effort"],
  ["reasoning", "effort"],
  ["reasoning_effort"]
];

export function setup() {
  return {
    gatewayRequestTransforms: [
      {
        id: "effort-ladder",
        transform: coerceEffortToSupportedLevel
      }
    ]
  };
}

function coerceEffortToSupportedLevel(input, context) {
  const body = input.body;
  if (!isRecord(body)) {
    return undefined;
  }

  const supportedEfforts = supportedEffortsForRoutedModel(input.routedModel ?? body.model, context.config);
  if (!supportedEfforts || supportedEfforts.size === 0) {
    return undefined;
  }

  const coercions = EFFORT_BODY_PATHS
    .map((path) => ({ path, requested: readEffort(body, path) }))
    .filter(({ requested }) => requested && !supportedEfforts.has(requested))
    .map((candidate) => ({ ...candidate, coerced: nearestSupportedEffort(candidate.requested, supportedEfforts) }))
    .filter(({ coerced }) => Boolean(coerced));

  if (coercions.length === 0) {
    return undefined;
  }

  for (const { coerced, path } of coercions) {
    writeEffort(body, path, coerced);
  }
  return {
    body,
    responseHeaders: {
      "x-ccr-effort-ladder": coercions.map(({ coerced, requested }) => `${requested}>${coerced}`).join(",")
    }
  };
}

function nearestSupportedEffort(requested, supportedEfforts) {
  const requestedIndex = EFFORT_LADDER.indexOf(requested);
  if (requestedIndex < 0) {
    return undefined;
  }
  const lowerEffort = EFFORT_LADDER.slice(0, requestedIndex).reverse().find((effort) => supportedEfforts.has(effort));
  return lowerEffort ?? EFFORT_LADDER.slice(requestedIndex + 1).find((effort) => supportedEfforts.has(effort));
}

function supportedEffortsForRoutedModel(selector, config) {
  const normalizedSelector = normalize(selector);
  if (!normalizedSelector) {
    return undefined;
  }

  for (const provider of config?.Providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    for (const model of provider.models ?? []) {
      const levels = provider.modelMetadata?.[model]?.supportedReasoningLevels;
      if (!levels?.length || !selectorMatchesProviderModel(normalizedSelector, provider, model)) {
        continue;
      }
      return new Set(levels.map((level) => normalize(level?.effort)).filter(Boolean));
    }
  }
  return undefined;
}

function selectorMatchesProviderModel(normalizedSelector, provider, model) {
  const normalizedModel = normalize(model);
  if (normalizedSelector === normalizedModel) {
    return true;
  }
  const providerSeparator = normalizedSelector.indexOf("/");
  if (providerSeparator <= 0 || normalizedSelector.slice(providerSeparator + 1) !== normalizedModel) {
    return false;
  }
  const selectorProvider = normalizedSelector.slice(0, providerSeparator).split("::")[0];
  return providerIdentifiers(provider).includes(selectorProvider);
}

function providerIdentifiers(provider) {
  return [provider.id, provider.name, provider.provider]
    .filter((value) => typeof value === "string" && value.trim())
    .flatMap((value) => [normalize(value), normalize(value).replace(/[^a-z0-9_.-]+/g, "-")]);
}

function readEffort(body, path) {
  const value = path.reduce((current, key) => (isRecord(current) ? current[key] : undefined), body);
  return typeof value === "string" ? normalize(value) : undefined;
}

function writeEffort(body, path, effort) {
  const container = path.slice(0, -1).reduce((current, key) => current[key], body);
  container[path[path.length - 1]] = effort;
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
