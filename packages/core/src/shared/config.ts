import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateConfig } from "./types";

export const CONFIG_VERSION = 4;
export const DEFAULT_PORT = 7800;
/** Default on-disk home for the gateway's data: data.json + logs.jsonl live here. */
export const DEFAULT_DATA_DIR = join(homedir(), ".myapikey");

/** A fresh config with a randomly generated single account/password + API key. */
export function defaultConfig(): GateConfig {
  return {
    version: CONFIG_VERSION,
    account: { username: "admin", password: randomBytes(18).toString("base64url") },
    apiKey: newApiKey(),
    providers: [],
    models: {},
  };
}

/** Generate an API key (sk-myapikey-…) used by agents to call /v1. */
export function newApiKey(): string {
  return "sk-myapikey-" + randomBytes(24).toString("base64url");
}

/** Generate a provider id. */
export function newProviderId(): string {
  return "prv_" + randomBytes(8).toString("base64url");
}

/** Strip trailing slashes from a base url. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}
