/**
 * Effective API URL resolver.
 *
 * Combines three sources into a single priority chain:
 *   1. DB `settings.api_url` — manually set by admin via /sub_url or Web Console
 *   2. Cloudflare Tunnel URL — auto-assigned when `CLOUDFLARE_TUNNEL=quick`
 *   3. `config.DEFAULT_API_URL` — environment variable fallback
 *
 * Admin's explicit manual override always wins. Tunnel URL is only used when
 * the admin hasn't set a custom value, so enabling/disabling a tunnel won't
 * clobber a deliberate configuration.
 */

import { config } from "./config.js";
import { getSetting } from "./db/database.js";
import { getTunnelUrl } from "./tunnel.js";

/**
 * Resolve the API URL that should be shown to users / used for Web Console
 * login links, considering manual override, tunnel URL and env fallback.
 */
export async function getEffectiveApiUrl(): Promise<string> {
  return (await getSetting("api_url")) ?? getTunnelUrl() ?? config.DEFAULT_API_URL;
}
