interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

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

async function telegramApi(
  env: Env,
  method: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const telegramUrl =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/" +
    method;

  const response = await fetch(telegramUrl, {
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
      "Telegram API error: " +
      (result.description ?? "Unknown error"),
    );
  }

  return result.result;
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: unknown[][],
): Promise<void> {
  const parameters: Record<string, unknown> = {
    chat_id: chatId,
    text: text,
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

async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
): Promise<void> {
  await telegramApi(
    env,
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
    },
  );
}

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

async function showMainMenu(
  env: Env,
  chatId: number,
  firstName?: string,
): Promise<void> {
  const name = firstName
    ? " " + firstName
    : "";

  const text =
    "✈️ Flight Tracker\n\n" +
    "Hello" +
    name +
    "!\n\n" +
    "Welcome to your flight availability " +
    "and price tracker.\n\n" +
    "Choose an option below:";

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

async function showMainMenuButton(
  env: Env,
  chatId: number,
): Promise<void> {
  await sendMessage(
    env,
    chatId,
    "Choose an option:",
    [
      [
        {
          text: "🏠 Main Menu",
          callback_data: "menu:main",
        },
      ],
    ],
  );
}

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
        "➕ Add Route\n\n" +
        "This section will guide you through:\n\n" +
        "• Origin\n" +
        "• Destination\n" +
        "• Shamsi flight date\n" +
        "• Ticket websites\n" +
        "• Check interval",
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
        "📋 My Routes\n\n" +
        "Your saved routes will appear here.",
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
        "🔍 Check Route\n\n" +
        "The route checker will be implemented here.",
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
        "📊 Results\n\n" +
        "Flight availability and price history " +
        "will appear here.",
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
    "⚙️ Settings\n\n" +
    "Choose what you want to configure:",
    [
      [
        {
          text: "🌍 Origins",
          callback_data: "settings:origins",
        },
        {
          text: "📍 Destinations",
          callback_data: "settings:destinations",
        },
      ],
      [
        {
          text: "🌐 Ticket Websites",
          callback_data: "settings:websites",
        },
      ],
      [
        {
          text: "⏱ Check Intervals",
          callback_data: "settings:intervals",
        },
      ],
      [
        {
          text: "🔔 Notifications",
          callback_data: "settings:notifications",
        },
      ],
      [
        {
          text: "🌐 Language",
          callback_data: "settings:language",
        },
      ],
      [
        {
          text: "⬅️ Main Menu",
          callback_data: "menu:main",
        },
      ],
    ],
  );
  break;
case "settings:origins": {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        name_fa,
        airport_code,
        is_active
      FROM origins
      ORDER BY sort_order, name
    `)
    .all();

  const origins = result.results as Array<{
    id: number;
    name: string;
    name_fa: string | null;
    airport_code: string;
    is_active: number;
  }>;

  if (origins.length === 0) {
    await sendMessage(
      env,
      chatId,
      "🌍 Origins\n\n" +
      "There are currently no origins configured.",
      [
        [
          {
            text: "➕ Add Origin",
            callback_data: "origin:add",
          },
        ],
        [
          {
            text: "⬅️ Settings",
            callback_data: "menu:settings",
          },
        ],
      ],
    );
    break;
  }

  const keyboard = origins.map((origin) => [
    {
      text:
        (origin.is_active ? "🟢 " : "🔴 ") +
        origin.name +
        " (" +
        origin.airport_code +
        ")",
      callback_data:
        "origin:toggle:" + origin.id,
    },
  ]);

  keyboard.push([
    {
      text: "➕ Add Origin",
      callback_data: "origin:add",
    },
  ]);

  keyboard.push([
    {
      text: "⬅️ Settings",
      callback_data: "menu:settings",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "🌍 Origins\n\n" +
    "🟢 = Active\n" +
    "🔴 = Disabled\n\n" +
    "Tap an origin to enable or disable it.",
    keyboard,
  );

  break;
}
      case "origin:toggle": {
  const originId = Number(
    data.split(":")[2],
  );

  if (!Number.isInteger(originId)) {
    break;
  }

  await env.DB
    .prepare(`
      UPDATE origins
      SET
        is_active =
          CASE
            WHEN is_active = 1 THEN 0
            ELSE 1
          END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(originId)
    .run();

  await sendMessage(
    env,
    chatId,
    "✅ Origin status updated.",
    [
      [
        {
          text: "🌍 Back to Origins",
          callback_data: "settings:origins",
        },
      ],
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
        },
      ],
    ],
  );

  break;
}

case "settings:destinations":
  await sendMessage(
    env,
    chatId,
    "📍 Destinations\n\n" +
    "Destination management will be implemented here.",
    [
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
        },
      ],
    ],
  );
  break;

case "settings:websites":
  await sendMessage(
    env,
    chatId,
    "🌐 Ticket Websites\n\n" +
    "Website management will be implemented here.",
    [
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
        },
      ],
    ],
  );
  break;

case "settings:intervals":
  await sendMessage(
    env,
    chatId,
    "⏱ Check Intervals\n\n" +
    "Check interval management will be implemented here.",
    [
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
        },
      ],
    ],
  );
  break;

case "settings:notifications":
  await sendMessage(
    env,
    chatId,
    "🔔 Notifications\n\n" +
    "Notification settings will be implemented here.",
    [
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
        },
      ],
    ],
  );
  break;

case "settings:language":
  await sendMessage(
    env,
    chatId,
    "🌐 Language\n\n" +
    "Language settings will be implemented here.",
    [
      [
        {
          text: "⬅️ Settings",
          callback_data: "menu:settings",
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
        "⚠️ I don't recognize that button.\n\n" +
        "Please return to the main menu.",
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

async function handleTelegramUpdate(
  env: Env,
  update: TelegramUpdate,
): Promise<void> {
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

    if (text === "/start") {
      await showMainMenu(
        env,
        chatId,
        user?.first_name,
      );
      return;
    }

    await sendMessage(
      env,
      chatId,
      "Please use the buttons below.\n\n" +
      "You normally won't need to type anything.",
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

  if (update.callback_query) {
    await handleButton(
      env,
      update.callback_query,
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url =
      new URL(request.url);

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

    if (
      request.method === "POST" &&
      url.pathname === "/telegram/webhook"
    ) {
      const telegramSecret =
        request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token",
        );

      if (
        !telegramSecret ||
        telegramSecret !==
          env.TELEGRAM_WEBHOOK_SECRET
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
      }

      return new Response(
        "OK",
        {
          status: 200,
        },
      );
    }

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

      const webhookUrl =
        url.origin +
        "/telegram/webhook";

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

    return new Response(
      "Not Found",
      {
        status: 404,
      },
    );
  },
};
