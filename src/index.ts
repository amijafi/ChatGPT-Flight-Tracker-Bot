```typescript
/**
 * ============================================================
 * Flight Tracker Bot
 * ============================================================
 *
 * Main Cloudflare Worker entry point.
 *
 * Responsibilities at this stage:
 *
 * 1. Receive Telegram webhook updates.
 * 2. Verify Telegram's webhook secret.
 * 3. Register Telegram users in D1.
 * 4. Display the main menu.
 * 5. Handle the first set of menu buttons.
 * 6. Provide a cloud-only webhook setup endpoint.
 *
 * Later we will add:
 *
 * - Route management
 * - Shamsi/Jalali calendar
 * - Settings
 * - Flight scraping jobs
 * - GitHub Actions communication
 * - Price history
 * - Notifications
 * ============================================================
 */


/**
 * ------------------------------------------------------------
 * Cloudflare Worker environment bindings
 * ------------------------------------------------------------
 *
 * These values are NOT stored in the source code.
 *
 * DB:
 *     D1 database binding created in Cloudflare.
 *
 * TELEGRAM_BOT_TOKEN:
 *     Cloudflare Secret containing the Telegram bot token.
 *
 * TELEGRAM_WEBHOOK_SECRET:
 *     Cloudflare Secret used to authenticate Telegram webhook
 *     requests and protect the webhook setup endpoint.
 */
interface Env {
  DB: D1Database;

  TELEGRAM_BOT_TOKEN: string;

  TELEGRAM_WEBHOOK_SECRET: string;
}


/**
 * ------------------------------------------------------------
 * Telegram API types
 * ------------------------------------------------------------
 *
 * We only define the parts of Telegram's API that we need
 * right now.
 *
 * We will expand these types as the bot grows.
 */
interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}


interface TelegramChat {
  id: number;
  type: string;
}


interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}


interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}


interface TelegramUpdate {
  update_id: number;

  message?: TelegramMessage;

  callback_query?: TelegramCallbackQuery;
}


/**
 * ------------------------------------------------------------
 * Telegram API helper
 * ------------------------------------------------------------
 *
 * All communication with Telegram goes through this function.
 *
 * The bot token comes from Cloudflare Secrets.
 */
async function telegramApi(
  env: Env,
  method: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(parameters),
  });

  const result = await response.json() as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };

  if (!result.ok) {
    throw new Error(
      `Telegram API error: ${result.description ?? "Unknown error"}`
    );
  }

  return result.result;
}

/**
 * ------------------------------------------------------------
 * Send a Telegram message
 * ------------------------------------------------------------
 */
async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: unknown[][],
): Promise<void> {

  const parameters: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };


  if (keyboard) {
    parameters.reply_markup = {
      inline_keyboard: keyboard,
    };
  }


  await telegramApi(
    env,
    "sendMessage",
    parameters,
  );
}


/**
 * ------------------------------------------------------------
 * Answer a Telegram callback query
 * ------------------------------------------------------------
 *
 * Telegram displays a small loading indicator after a user
 * presses an inline keyboard button.
 *
 * Telegram requires the bot to answer the callback query.
 */
async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {

  const parameters: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };


  if (text) {
    parameters.text = text;
  }


  await telegramApi(
    env,
    "answerCallbackQuery",
    parameters,
  );
}


/**
 * ------------------------------------------------------------
 * Register/update a Telegram user in D1
 * ------------------------------------------------------------
 *
 * We use INSERT ... ON CONFLICT so that:
 *
 * - First interaction → user is created.
 * - Later interaction → existing user is updated.
 */
async function registerUser(
  env: Env,
  user: TelegramUser,
): Promise<void> {

  await env.DB
    .prepare(`
      INSERT INTO users (
        telegram_user_id,
        username,
        first_name,
        last_name,
        language_code,
        is_active,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)

      ON CONFLICT(telegram_user_id)
      DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        language_code = excluded.language_code,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      user.id,
      user.username ?? null,
      user.first_name,
      user.last_name ?? null,
      user.language_code ?? null,
    )
    .run();
}


/**
 * ------------------------------------------------------------
 * Main menu
 * ------------------------------------------------------------
 *
 * This is the central navigation screen.
 *
 * Eventually every normal operation will be reachable from
 * these buttons.
 */
async function showMainMenu(
  env: Env,
  chatId: number,
  firstName?: string,
): Promise<void> {

  const name = firstName
    ? ` ${firstName}`
    : "";


  const text =
`✈️ Flight Tracker

Hello${name}!

Welcome to your flight availability and price tracker.

Choose an option below:`;


  const keyboard = [

    [
      {
        text: "➕ Add Route",
        callback_data: "menu:add_route",
      },

      {
        text: "📋 My Routes",
        callback_data: "menu:routes",
      },
    ],

    [
      {
        text: "🔍 Check Route",
        callback_data: "menu:check",
      },

      {
        text: "📊 Results",
        callback_data: "menu:results",
      },
    ],

    [
      {
        text: "⚙️ Settings",
        callback_data: "menu:settings",
      },
    ],

  ];


  await sendMessage(
    env,
    chatId,
    text,
    keyboard,
  );
}


/**
 * ------------------------------------------------------------
 * Temporary menu handler
 * ------------------------------------------------------------
 *
 * These are placeholders for now.
 *
 * We will replace them one by one with the real functionality.
 */
async function handleButton(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {

  const chatId =
    callbackQuery.message?.chat.id;


  if (!chatId) {
    return;
  }


  const data =
    callbackQuery.data ?? "";


  await answerCallbackQuery(
    env,
    callbackQuery.id,
  );


  switch (data) {

    case "menu:add_route":

      await sendMessage(
        env,
        chatId,
        "➕ Add Route\n\nThis section will guide you through origin, destination, Shamsi date, websites and check interval.",
        [
          [
            {
              text: "⬅️ Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;


    case "menu:routes":

      await sendMessage(
        env,
        chatId,
        "📋 My Routes\n\nYour saved routes will appear here.",
        [
          [
            {
              text: "⬅️ Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;


    case "menu:check":

      await sendMessage(
        env,
        chatId,
        "🔍 Check Route\n\nThe route checker will be implemented here.",
        [
          [
            {
              text: "⬅️ Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;


    case "menu:results":

      await sendMessage(
        env,
        chatId,
        "📊 Results\n\nFlight availability and price history will appear here.",
        [
          [
            {
              text: "⬅️ Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;


    case "menu:settings":

      await sendMessage(
        env,
        chatId,
        "⚙️ Settings\n\nThis will become the only place where configuration data is entered manually.",
        [
          [
            {
              text: "⬅️ Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;


    case "menu:main":

      await showMainMenu(
        env,
        chatId,
        callbackQuery.from.first_name,
      );

      break;


    default:

      await sendMessage(
        env,
        chatId,
        "⚠️ I don't recognize that button anymore. Please return to the main menu.",
        [
          [
            {
              text: "🏠 Main Menu",
              callback_data: "menu:main",
            },
          ],
        ],
      );

      break;
  }
}


/**
 * ------------------------------------------------------------
 * Telegram webhook handler
 * ------------------------------------------------------------
 */
async function handleTelegramUpdate(
  env: Env,
  update: TelegramUpdate,
): Promise<void> {


  /**
   * ----------------------------------------------------------
   * Normal Telegram message
   * ----------------------------------------------------------
   */
  if (update.message) {

    const user =
      update.message.from;


    const chatId =
      update.message.chat.id;


    if (user) {

      await registerUser(
        env,
        user,
      );

    }


    const text =
      update.message.text ?? "";


    /**
     * /start
     */
    if (text === "/start") {

      await showMainMenu(
        env,
        chatId,
        user?.first_name,
      );

      return;
    }


    /**
     * For now, any ordinary text message simply points the
     * user back to the button interface.
     *
     * Later Settings will temporarily allow text input when
     * the user is configuring airports/websites/etc.
     */
    await sendMessage(
      env,
      chatId,
      "Please use the buttons below. You won't normally need to type anything.",
      [
        [
          {
            text: "🏠 Main Menu",
            callback_data: "menu:main",
          },
        ],
      ],
    );


    return;
  }


  /**
   * ----------------------------------------------------------
   * Inline keyboard button
   * ----------------------------------------------------------
   */
  if (update.callback_query) {

    await handleButton(
      env,
      update.callback_query,
    );

    return;
  }
}


/**
 * ------------------------------------------------------------
 * Main Worker
 * ------------------------------------------------------------
 */
export default {

  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {


    const url =
      new URL(request.url);


    /**
     * --------------------------------------------------------
     * Health check
     * --------------------------------------------------------
     *
     * Opening the Worker URL in a browser should still show
     * that the Worker is alive.
     */
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {

      return new Response(
        "✈️ Flight Tracker Bot is alive!",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
          },
        },
      );
    }


    /**
     * --------------------------------------------------------
     * Telegram webhook
     * --------------------------------------------------------
     */
    if (
      request.method === "POST" &&
      url.pathname === "/telegram/webhook"
    ) {


      /**
       * Verify Telegram's secret header.
       */
      const telegramSecret =
        request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );


      if (
        !telegramSecret ||
        telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401,
          },
        );
      }


      let update: TelegramUpdate;


      try {

        update =
          await request.json() as TelegramUpdate;

      } catch {

        return new Response(
          "Invalid JSON",
          {
            status: 400,
          },
        );
      }


      try {

        await handleTelegramUpdate(
          env,
          update,
        );

      } catch (error) {

        console.error(
          "Telegram update processing failed:",
          error,
        );

        /**
         * We still return HTTP 200 here.
         *
         * Telegram retries webhook requests when the webhook
         * returns a non-2xx response. For some failures we
         * don't want an update to be processed repeatedly.
         */
      }


      return new Response(
        "OK",
        {
          status: 200,
        },
      );
    }


    /**
     * --------------------------------------------------------
     * Cloud-only webhook setup
     * --------------------------------------------------------
     *
     * This allows us to configure Telegram's webhook without
     * using curl or any local software.
     *
     * We will call:
     *
     * /setup-webhook?key=YOUR_SECRET
     *
     * The Worker itself then calls Telegram's setWebhook API.
     */
    if (
      request.method === "GET" &&
      url.pathname === "/setup-webhook"
    ) {


      const key =
        url.searchParams.get("key");


      if (
        !key ||
        key !== env.TELEGRAM_WEBHOOK_SECRET
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401,
          },
        );
      }


      /**
       * The webhook URL itself is NOT the secret setup URL.
       *
       * Telegram will send the secret in a HTTP header.
       */
      const webhookUrl =
        `${url.origin}/telegram/webhook`;


      try {

        const result =
          await telegramApi(
            env,
            "setWebhook",
            {
              url: webhookUrl,

              secret_token:
                env.TELEGRAM_WEBHOOK_SECRET,

              allowed_updates: [
                "message",
                "callback_query",
              ],

              drop_pending_updates: true,
            },
          );


        return Response.json({
          ok: true,
          webhook_url: webhookUrl,
          telegram_result: result,
        });

      } catch (error) {

        return Response.json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          {
            status: 500,
          },
        );
      }
    }


    /**
     * --------------------------------------------------------
     * Everything else
     * --------------------------------------------------------
     */
    return new Response(
      "Not Found",
      {
        status: 404,
      },
    );
  },
};
```
