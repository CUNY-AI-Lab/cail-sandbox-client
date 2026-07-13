export const LOCAL_E2E_WORKER_NAME = "cail-sandbox-bridge-local-e2e";

export const LOCAL_E2E_WRANGLER_ARGS = [
  "--local",
  "--ip",
  "127.0.0.1",
  "--persist-to",
] as const;

export const LOCAL_E2E_SECRET_ENV_PATTERN =
  /^(?:(?:CLOUDFLARE|CF|R2|AWS)_.*(?:TOKEN|KEY|SECRET|ACCOUNT)(?:_ID)?|CAIL_.*(?:TOKEN|KEY|SECRET)(?:_ID)?)$/;

export function sanitizedLocalE2EEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (LOCAL_E2E_SECRET_ENV_PATTERN.test(key)) delete environment[key];
  }
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  return environment;
}
