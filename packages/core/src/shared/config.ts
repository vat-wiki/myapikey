import { randomBytes } from "node:crypto";
import type { GateConfig } from "./types";

export const CONFIG_VERSION = 1;
export const DEFAULT_PORT = 7800;

/** A fresh config with a randomly generated single account/password. */
export function defaultConfig(): GateConfig {
  return {
    version: CONFIG_VERSION,
    account: { username: "admin", password: randomBytes(18).toString("base64url") },
    providers: [],
    models: {},
  };
}

/** Generate a provider id. */
export function newProviderId(): string {
  return "prv_" + randomBytes(8).toString("base64url");
}

/** Strip trailing slashes from a base url. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}
