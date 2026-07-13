import { expect, test } from "bun:test";
import {
  LOCAL_E2E_WRANGLER_ARGS,
  sanitizedLocalE2EEnvironment,
} from "../scripts/local-continuity-policy.js";

test("local continuity launch is loopback-only and disables remote bindings", () => {
  expect(LOCAL_E2E_WRANGLER_ARGS).toEqual([
    "--local",
    "--ip",
    "127.0.0.1",
    "--persist-to",
  ]);
});

test("local continuity child environment strips remote credentials", () => {
  const environment = sanitizedLocalE2EEnvironment({
    PATH: "/bin",
    CLOUDFLARE_API_TOKEN: "production-token",
    CF_ACCOUNT_ID: "production-account",
    R2_SECRET_ACCESS_KEY: "production-secret",
    AWS_ACCESS_KEY_ID: "production-key",
    CAIL_SANDBOX_TOKEN: "production-cail-token",
  });

  expect(environment).toEqual({
    PATH: "/bin",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  });
});
