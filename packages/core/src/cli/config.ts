import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CliProfile {
  url: string;
  username: string;
  password: string;
}

export const CONFIG_PATH = join(homedir(), ".config", "mygate", "config.json");

export function loadProfile(): CliProfile | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CliProfile;
  } catch {
    return null;
  }
}

export function saveProfile(p: CliProfile): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(p, null, 2));
}

export function resolveUrl(flag?: string): string {
  if (flag) return flag;
  if (process.env.MYGATE_URL) return process.env.MYGATE_URL;
  return loadProfile()?.url ?? "http://localhost:7800";
}

export function resolveCreds(
  flagUser?: string,
  flagPass?: string,
): { username: string; password: string } | null {
  const profile = loadProfile();
  const user = flagUser ?? process.env.MYGATE_USER ?? profile?.username;
  const pass = flagPass ?? process.env.MYGATE_PASS ?? profile?.password;
  if (!user || !pass) return null;
  return { username: user, password: pass };
}
