/**
 * Flight Tracker Bot
 *
 * This is the main Cloudflare Worker entry point.
 *
 * For now, this is only a connection test.
 * We will gradually replace this with:
 *
 * Telegram webhook handling
 * D1 database access
 * Route management
 * Scheduling
 * GitHub scraper communication
 * Flight-price notifications
 */

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(
      "✈️ Flight Tracker Bot is alive!",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
        },
      },
    );
  },
};
