/**
 * Cloudflare Tunnel integration — exposes the local API server via a
 * Cloudflare Tunnel without requiring a separately installed cloudflared binary.
 *
 * Controlled by environment variables:
 *   CLOUDFLARE_TUNNEL=quick   → temporary trycloudflare.com URL (no account needed)
 *   CLOUDFLARE_TUNNEL=token   → named tunnel via Cloudflare Dashboard (needs CLOUDFLARE_TOKEN)
 *   (empty / unset)           → tunnel disabled, no-op
 */

import { existsSync } from "fs";
import { Tunnel, bin, install } from "cloudflared";

let tunnelInstance: Tunnel | null = null;
let currentTunnelUrl: string | null = null;

/**
 * Start a Cloudflare Tunnel for the given local port.
 * No-op if CLOUDFLARE_TUNNEL is not set.
 */
export async function startTunnel(port: number): Promise<void> {
  const mode = process.env.CLOUDFLARE_TUNNEL;
  if (!mode) return; // Tunnel not enabled

  // Ensure the cloudflared binary is available
  if (!existsSync(bin)) {
    console.log("[tunnel] Installing cloudflared binary...");
    await install(bin);
  }

  if (mode === "quick") {
    tunnelInstance = Tunnel.quick(`http://localhost:${port}`);
  } else if (mode === "token") {
    const token = process.env.CLOUDFLARE_TOKEN;
    if (!token) {
      console.error("[tunnel] CLOUDFLARE_TUNNEL=token but CLOUDFLARE_TOKEN is not set — skipping tunnel");
      return;
    }
    tunnelInstance = Tunnel.withToken(token);
  } else {
    console.error(`[tunnel] Unknown CLOUDFLARE_TUNNEL mode "${mode}" (expected "quick" or "token") — skipping tunnel`);
    return;
  }

  tunnelInstance.on("url", (url: string) => {
    currentTunnelUrl = url;
    console.log(`[tunnel] ▶ Public URL: ${url}`);
    console.log(`[tunnel]   API:    ${url}/v1/*`);
    console.log(`[tunnel]   Web:    ${url}/web/`);
  });

  tunnelInstance.on("connected", (conn: { id: string; ip: string; location: string }) => {
    console.log(`[tunnel] Connected to Cloudflare edge: ${conn.location} (${conn.ip})`);
  });

  tunnelInstance.on("disconnected", () => {
    console.warn("[tunnel] Disconnected from edge (will auto-reconnect)");
  });

  tunnelInstance.on("error", (err: Error) => {
    console.error(`[tunnel] Error: ${err.message}`);
  });

  tunnelInstance.on("exit", (code: number | null) => {
    console.log(`[tunnel] Process exited (code ${code})`);
    tunnelInstance = null;
    currentTunnelUrl = null;
  });

  console.log(`[tunnel] Starting Cloudflare Tunnel (mode: ${mode}) → localhost:${port}`);
}

/**
 * Stop the active tunnel (if any). Safe to call multiple times.
 */
export function stopTunnel(): void {
  if (tunnelInstance) {
    tunnelInstance.stop();
    tunnelInstance = null;
    currentTunnelUrl = null;
  }
}

/**
 * Return the current Cloudflare Tunnel public URL, or null if no tunnel is
 * active (or the URL has not been assigned yet — quick tunnels assign the
 * URL asynchronously after connecting).
 *
 * This is used as a fallback for the "effective API URL" when the admin has
 * not manually overridden api_url via /sub_url or Web Console settings.
 */
export function getTunnelUrl(): string | null {
  return currentTunnelUrl;
}
