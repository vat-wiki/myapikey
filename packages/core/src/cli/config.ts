import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_DATA_DIR } from "../shared/config";

export interface CliProfile {
  url: string;
  username: string;
  password: string;
  apiKey: string;
}

/**
 * Where the CLI client profile lives. Pinned to the default app home
 * (~/.myapikey) regardless of the server's --data-dir override — client commands
 * (whoami / provider / model / call) need a stable, discoverable path and never
 * see --data-dir. The legacy ~/.config/myapikey/config.json is still read as a
 * fallback so existing setups keep working after upgrade.
 */
export const CLIENT_PROFILE_PATH = join(DEFAULT_DATA_DIR, "client.json");
const LEGACY_PROFILE_PATH = join(homedir(), ".config", "myapikey", "config.json");

function resolveProfilePath(): string {
  if (existsSync(CLIENT_PROFILE_PATH)) return CLIENT_PROFILE_PATH;
  if (existsSync(LEGACY_PROFILE_PATH)) return LEGACY_PROFILE_PATH;
  return CLIENT_PROFILE_PATH;
}

export function loadProfile(): CliProfile | null {
  const path = resolveProfilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliProfile;
  } catch {
    return null;
  }
}

export function saveProfile(p: CliProfile): void {
  mkdirSync(dirname(CLIENT_PROFILE_PATH), { recursive: true });
  writeFileSync(CLIENT_PROFILE_PATH, JSON.stringify(p, null, 2));
}

export function resolveUrl(flag?: string): string {
  if (flag) return flag;
  if (process.env.MYAPIKEY_URL) return process.env.MYAPIKEY_URL;
  return loadProfile()?.url ?? "http://localhost:7800";
}

export function resolveCreds(
  flagUser?: string,
  flagPass?: string,
): { username: string; password: string } | null {
  const profile = loadProfile();
  const user = flagUser ?? process.env.MYAPIKEY_USER ?? profile?.username;
  const pass = flagPass ?? process.env.MYAPIKEY_PASS ?? profile?.password;
  if (!user || !pass) return null;
  return { username: user, password: pass };
}

/** Resolve the API key used to call /v1: flag → env → saved profile. */
export function resolveApiKey(flag?: string): string | undefined {
  return flag ?? process.env.MYAPIKEY_API_KEY ?? loadProfile()?.apiKey;
}
