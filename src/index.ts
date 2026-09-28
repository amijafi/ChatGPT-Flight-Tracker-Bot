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

interface ConversationState {
  state: string;
  data: Record<string, unknown>;
}

type KeyboardButton = {
  text: string;
  callback_data: string;
};

type Keyboard = KeyboardButton[][];

/* ============================================================
   TELEGRAM API
   ============================================================ */

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

async function sendNewMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<number> {
  const parameters: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: keyboard ?? [],
    },
  };

  const result =
    await telegramApi(
      env,
      "sendMessage",
      parameters,
    ) as TelegramMessage;

  return result.message_id;
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<void> {
  const existing =
    await env.DB
      .prepare(`
        SELECT message_id
        FROM ui_messages
        WHERE chat_id = ?
      `)
      .bind(chatId)
      .first<{ message_id: number }>();

  const replyMarkup = {
    inline_keyboard: keyboard ?? [],
  };

  if (existing) {
    try {
      await telegramApi(
        env,
        "editMessageText",
        {
          chat_id: chatId,
          message_id:
            existing.message_id,
          text,
          reply_markup:
            replyMarkup,
        },
      );

      return;
    } catch {
      // The previous UI message may have been deleted manually.
      // Fall through and create a new UI message.
    }
  }

  const messageId =
    await sendNewMessage(
      env,
      chatId,
      text,
      keyboard,
    );

  await env.DB
    .prepare(`
      INSERT INTO ui_messages (
        chat_id,
        message_id,
        updated_at
      )
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id)
      DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      chatId,
      messageId,
    )
    .run();
}

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

/* ============================================================
   USER MANAGEMENT
   ============================================================ */

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

  await env.DB
    .prepare(`
      INSERT INTO user_settings (
        user_id,
        notifications_enabled,
        language,
        updated_at
      )
      SELECT
        id,
        1,
        'en',
        CURRENT_TIMESTAMP
      FROM users
      WHERE telegram_user_id = ?
      ON CONFLICT(user_id)
      DO NOTHING
    `)
    .bind(user.id)
    .run();
}

/* ============================================================
   CONVERSATION STATE
   ============================================================ */

async function setConversationState(
  env: Env,
  telegramUserId: number,
  state: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const userResult = await env.DB
    .prepare(`
      SELECT id
      FROM users
      WHERE telegram_user_id = ?
    `)
    .bind(telegramUserId)
    .first<{ id: number }>();

  if (!userResult) {
    return;
  }

  await env.DB
    .prepare(`
      INSERT INTO conversation_states (
        user_id,
        state,
        data,
        updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)

      ON CONFLICT(user_id)
      DO UPDATE SET
        state = excluded.state,
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      userResult.id,
      state,
      data ? JSON.stringify(data) : null,
    )
    .run();
}

async function getConversationState(
  env: Env,
  telegramUserId: number,
): Promise<ConversationState | null> {
  const result = await env.DB
    .prepare(`
      SELECT
        cs.state,
        cs.data
      FROM conversation_states cs
      INNER JOIN users u
        ON u.id = cs.user_id
      WHERE u.telegram_user_id = ?
    `)
    .bind(telegramUserId)
    .first<{
      state: string;
      data: string | null;
    }>();

  if (!result) {
    return null;
  }

  let data: Record<string, unknown> = {};

  if (result.data) {
    try {
      data = JSON.parse(result.data) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  return {
    state: result.state,
    data,
  };
}

async function clearConversationState(
  env: Env,
  telegramUserId: number,
): Promise<void> {
  await setConversationState(
    env,
    telegramUserId,
    "idle",
  );
}

/* ============================================================
   MAIN MENU
   ============================================================ */

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

  const keyboard: Keyboard = [
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

async function showSettingsMenu(
  env: Env,
  chatId: number,
): Promise<void> {
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
}

/* ============================================================
   JALALI CALENDAR
   ============================================================ */

function div(a: number, b: number): number {
  return Math.floor(a / b);
}

function jalaliToGregorian(
  jy: number,
  jm: number,
  jd: number,
): string {
  jy += 1595;

  let days =
    -355668 +
    365 * jy +
    div(jy + 3, 4) -
    div(jy + 99, 100) +
    div(jy + 399, 400) +
    jd;

  if (jm < 7) {
    days += (jm - 1) * 31;
  } else {
    days += (jm - 1) * 30 + 6;
  }

  let gy = 400 * div(days, 146097);
  days %= 146097;

  if (days > 36524) {
    gy += 100 * div(--days, 36524);
    days %= 36524;

    if (days >= 365) {
      days++;
    }
  }

  gy += 4 * div(days, 1461);
  days %= 1461;

  if (days > 365) {
    gy += div(days - 1, 365);
    days = (days - 1) % 365;
  }

  const gd = days + 1;

  const leap =
    gy % 4 === 0 &&
    (gy % 100 !== 0 || gy % 400 === 0);

  const monthDays = [
    0,
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  let remaining = gd;
  let gm = 1;

  while (
    gm <= 12 &&
    remaining > monthDays[gm]
  ) {
    remaining -= monthDays[gm];
    gm++;
  }

  return (
    String(gy).padStart(4, "0") +
    "-" +
    String(gm).padStart(2, "0") +
    "-" +
    String(remaining).padStart(2, "0")
  );
}

function gregorianToJalali(
  gy: number,
  gm: number,
  gd: number,
): {
  year: number;
  month: number;
  day: number;
} {
  let gYear = gy - 1600;
  let gMonth = gm - 1;
  let gDay = gd - 1;

  const gDayNo =
    365 * gYear +
    div(gYear + 3, 4) -
    div(gYear + 99, 100) +
    div(gYear + 399, 400);

  const gMonthDays = [
    31,
    (gy % 4 === 0 &&
      (gy % 100 !== 0 || gy % 400 === 0))
      ? 29
      : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  let dayNo = gDayNo;

  for (let i = 0; i < gMonth; i++) {
    dayNo += gMonthDays[i];
  }

  dayNo += gDay;

  let jDayNo = dayNo - 79;

  const jNp = div(jDayNo, 12053);
  jDayNo %= 12053;

  let jy =
    979 +
    33 * jNp +
    4 * div(jDayNo, 1461);

  jDayNo %= 1461;

  if (jDayNo >= 366) {
    jy += div(jDayNo - 1, 365);
    jDayNo = (jDayNo - 1) % 365;
  }

  let jm: number;
  let jd: number;

  if (jDayNo < 186) {
    jm = 1 + div(jDayNo, 31);
    jd = 1 + (jDayNo % 31);
  } else {
    jm = 7 + div(jDayNo - 186, 30);
    jd = 1 + ((jDayNo - 186) % 30);
  }

  return {
    year: jy,
    month: jm,
    day: jd,
  };
}

function todayGregorian(): string {
  const now = new Date();

  return (
    now.getUTCFullYear() +
    "-" +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getUTCDate()).padStart(2, "0")
  );
}

function currentJalali(): {
  year: number;
  month: number;
  day: number;
} {
  const now = new Date();

  return gregorianToJalali(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    now.getUTCDate(),
  );
}

function jalaliMonthLength(
  year: number,
  month: number,
): number {
  if (month <= 6) {
    return 31;
  }

  if (month <= 11) {
    return 30;
  }

  const nextYear =
    month === 12
      ? year + 1
      : year;

  const gregorian = jalaliToGregorian(
    nextYear,
    1,
    1,
  );

  const date = new Date(
    gregorian + "T00:00:00Z",
  );

  const previous = new Date(
    date.getTime() -
    86400000,
  );

  const j = gregorianToJalali(
    previous.getUTCFullYear(),
    previous.getUTCMonth() + 1,
    previous.getUTCDate(),
  );

  return j.day;
}

async function showJalaliCalendar(
  env: Env,
  chatId: number,
  year: number,
  month: number,
): Promise<void> {
  if (month < 1) {
    month = 12;
    year--;
  }

  if (month > 12) {
    month = 1;
    year++;
  }

  const monthNames = [
    "",
    "Farvardin",
    "Ordibehesht",
    "Khordad",
    "Tir",
    "Mordad",
    "Shahrivar",
    "Mehr",
    "Aban",
    "Azar",
    "Dey",
    "Bahman",
    "Esfand",
  ];

  const weekdays = [
    "Sat",
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
  ];

  const keyboard: Keyboard = [];

  keyboard.push([
    {
      text: "⬅️",
      callback_data:
        "route:cal:" +
        (month === 1 ? year - 1 : year) +
        ":" +
        (month === 1 ? 12 : month - 1),
    },
    {
      text:
        monthNames[month] +
        " " +
        year,
      callback_data: "noop",
    },
    {
      text: "➡️",
      callback_data:
        "route:cal:" +
        (month === 12 ? year + 1 : year) +
        ":" +
        (month === 12 ? 1 : month + 1),
    },
  ]);

  keyboard.push(
    weekdays.map((day) => ({
      text: day,
      callback_data: "noop",
    })),
  );

  const firstGregorian =
    jalaliToGregorian(
      year,
      month,
      1,
    );

  const firstDate = new Date(
    firstGregorian + "T00:00:00Z",
  );

  const jsDay =
    firstDate.getUTCDay();

  const firstIndex =
    (jsDay + 1) % 7;

  const days =
    jalaliMonthLength(
      year,
      month,
    );

  let row: KeyboardButton[] = [];

  for (let i = 0; i < firstIndex; i++) {
    row.push({
      text: " ",
      callback_data: "noop",
    });
  }

  const today = todayGregorian();

  for (
    let day = 1;
    day <= days;
    day++
  ) {
    const gregorian =
      jalaliToGregorian(
        year,
        month,
        day,
      );

    const isPast =
      gregorian < today;

    row.push({
      text: String(day),
      callback_data:
        isPast
          ? "noop"
          : "route:date:" +
            gregorian +
            ":" +
            year +
            ":" +
            month +
            ":" +
            day,
    });

    if (row.length === 7) {
      keyboard.push(row);
      row = [];
    }
  }

  if (row.length > 0) {
    while (row.length < 7) {
      row.push({
        text: " ",
        callback_data: "noop",
      });
    }

    keyboard.push(row);
  }

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data: "route:cancel",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "📅 Select flight date\n\n" +
    "Please choose a Shamsi/Jalali date:",
    keyboard,
  );
}

/* ============================================================
   ORIGINS
   ============================================================ */

async function showOrigins(
  env: Env,
  chatId: number,
): Promise<void> {
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

    return;
  }

  const keyboard: Keyboard =
    origins.map((origin) => [
      {
        text:
          (origin.is_active
            ? "🟢 "
            : "🔴 ") +
          origin.name +
          " (" +
          origin.airport_code +
          ")",
        callback_data:
          "origin:toggle:" +
          origin.id,
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
}

/* ============================================================
   DESTINATIONS
   ============================================================ */

async function showDestinations(
  env: Env,
  chatId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        name_fa,
        airport_code,
        is_active
      FROM destinations
      ORDER BY sort_order, name
    `)
    .all();

  const destinations = result.results as Array<{
    id: number;
    name: string;
    name_fa: string | null;
    airport_code: string;
    is_active: number;
  }>;

  if (destinations.length === 0) {
    await sendMessage(
      env,
      chatId,
      "📍 Destinations\n\n" +
      "There are currently no destinations configured.",
      [
        [
          {
            text: "➕ Add Destination",
            callback_data: "destination:add",
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

    return;
  }

  const keyboard: Keyboard =
    destinations.map((destination) => [
      {
        text:
          (destination.is_active
            ? "🟢 "
            : "🔴 ") +
          destination.name +
          " (" +
          destination.airport_code +
          ")",
        callback_data:
          "destination:toggle:" +
          destination.id,
      },
    ]);

  keyboard.push([
    {
      text: "➕ Add Destination",
      callback_data: "destination:add",
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
    "📍 Destinations\n\n" +
    "🟢 = Active\n" +
    "🔴 = Disabled\n\n" +
    "Tap a destination to enable or disable it.",
    keyboard,
  );
}

/* ============================================================
   WEBSITES
   ============================================================ */

async function showWebsites(
  env: Env,
  chatId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        base_url,
        scraper_key,
        is_active
      FROM websites
      ORDER BY sort_order, name
    `)
    .all();

  const websites = result.results as Array<{
    id: number;
    name: string;
    base_url: string;
    scraper_key: string;
    is_active: number;
  }>;

  if (websites.length === 0) {
    await sendMessage(
      env,
      chatId,
      "🌐 Ticket Websites\n\n" +
      "There are currently no ticket websites configured.",
      [
        [
          {
            text: "➕ Add Website",
            callback_data: "website:add",
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

    return;
  }

  const keyboard: Keyboard =
    websites.map((website) => [
      {
        text:
          (website.is_active
            ? "🟢 "
            : "🔴 ") +
          website.name,
        callback_data:
          "website:toggle:" +
          website.id,
      },
    ]);

  keyboard.push([
    {
      text: "➕ Add Website",
      callback_data: "website:add",
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
    "🌐 Ticket Websites\n\n" +
    "🟢 = Active\n" +
    "🔴 = Disabled\n\n" +
    "Tap a website to enable or disable it.",
    keyboard,
  );
}

/* ============================================================
   INTERVALS
   ============================================================ */

async function showIntervals(
  env: Env,
  chatId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        minutes,
        is_active
      FROM check_intervals
      ORDER BY sort_order, minutes
    `)
    .all();

  const intervals = result.results as Array<{
    id: number;
    name: string;
    minutes: number;
    is_active: number;
  }>;

  if (intervals.length === 0) {
    await sendMessage(
      env,
      chatId,
      "⏱ Check Intervals\n\n" +
      "There are currently no intervals configured.",
      [
        [
          {
            text: "➕ Add Interval",
            callback_data: "interval:add",
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

    return;
  }

  const keyboard: Keyboard =
    intervals.map((interval) => [
      {
        text:
          (interval.is_active
            ? "🟢 "
            : "🔴 ") +
          interval.name +
          " (" +
          interval.minutes +
          " min)",
        callback_data:
          "interval:toggle:" +
          interval.id,
      },
    ]);

  keyboard.push([
    {
      text: "➕ Add Interval",
      callback_data: "interval:add",
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
    "⏱ Check Intervals\n\n" +
    "🟢 = Active\n" +
    "🔴 = Disabled\n\n" +
    "Tap an interval to enable or disable it.",
    keyboard,
  );
}

/* ============================================================
   ROUTE SELECTION
   ============================================================ */

async function startAddRoute(
  env: Env,
  chatId: number,
  telegramUserId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        airport_code
      FROM origins
      WHERE is_active = 1
      ORDER BY sort_order, name
    `)
    .all();

  const origins = result.results as Array<{
    id: number;
    name: string;
    airport_code: string;
  }>;

  if (origins.length === 0) {
    await sendMessage(
      env,
      chatId,
      "➕ Add Route\n\n" +
      "You need to configure at least one active origin first.\n\n" +
      "Go to Settings → Origins.",
      [
        [
          {
            text: "🌍 Origins",
            callback_data: "settings:origins",
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

    return;
  }

  await setConversationState(
    env,
    telegramUserId,
    "route:add:origin",
    {},
  );

  const keyboard: Keyboard =
    origins.map((origin) => [
      {
        text:
          origin.name +
          " (" +
          origin.airport_code +
          ")",
        callback_data:
          "route:origin:" +
          origin.id,
      },
    ]);

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data: "route:cancel",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "➕ Add Route\n\n" +
    "Step 1 of 5\n\n" +
    "Select the departure airport:",
    keyboard,
  );
}

async function showDestinationSelection(
  env: Env,
  chatId: number,
  telegramUserId: number,
  originId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        airport_code
      FROM destinations
      WHERE is_active = 1
      ORDER BY sort_order, name
    `)
    .all();

  const destinations = result.results as Array<{
    id: number;
    name: string;
    airport_code: string;
  }>;

  if (destinations.length === 0) {
    await sendMessage(
      env,
      chatId,
      "There are no active destinations configured.\n\n" +
      "Please add one under Settings → Destinations.",
      [
        [
          {
            text: "📍 Destinations",
            callback_data: "settings:destinations",
          },
        ],
        [
          {
            text: "❌ Cancel",
            callback_data: "route:cancel",
          },
        ],
      ],
    );

    return;
  }

  await setConversationState(
    env,
    telegramUserId,
    "route:add:destination",
    {
      origin_id: originId,
    },
  );

  const keyboard: Keyboard =
    destinations.map((destination) => [
      {
        text:
          destination.name +
          " (" +
          destination.airport_code +
          ")",
        callback_data:
          "route:destination:" +
          destination.id,
      },
    ]);

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data: "route:cancel",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "➕ Add Route\n\n" +
    "Step 2 of 5\n\n" +
    "Select the destination airport:",
    keyboard,
  );
}

async function showWebsiteSelection(
  env: Env,
  chatId: number,
  telegramUserId: number,
  data: Record<string, unknown>,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        is_active
      FROM websites
      WHERE is_active = 1
      ORDER BY sort_order, name
    `)
    .all();

  const websites = result.results as Array<{
    id: number;
    name: string;
    is_active: number;
  }>;

  if (websites.length === 0) {
    await sendMessage(
      env,
      chatId,
      "There are no active ticket websites configured.\n\n" +
      "Please add one under Settings → Ticket Websites.",
      [
        [
          {
            text: "🌐 Websites",
            callback_data: "settings:websites",
          },
        ],
        [
          {
            text: "❌ Cancel",
            callback_data: "route:cancel",
          },
        ],
      ],
    );

    return;
  }

  const selected =
    Array.isArray(data.website_ids)
      ? data.website_ids as number[]
      : [];

  await setConversationState(
    env,
    telegramUserId,
    "route:add:websites",
    {
      ...data,
      website_ids: selected,
    },
  );

  const keyboard: Keyboard =
    websites.map((website) => [
      {
        text:
          (selected.includes(website.id)
            ? "✅ "
            : "⬜ ") +
          website.name,
        callback_data:
          "route:website:" +
          website.id,
      },
    ]);

  keyboard.push([
    {
      text: "➡️ Done",
      callback_data: "route:websites:done",
    },
  ]);

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data: "route:cancel",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "➕ Add Route\n\n" +
    "Step 4 of 5\n\n" +
    "Select the ticket websites to check.\n\n" +
    "You can select multiple websites.",
    keyboard,
  );
}

async function showIntervalSelection(
  env: Env,
  chatId: number,
  telegramUserId: number,
  data: Record<string, unknown>,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        id,
        name,
        minutes
      FROM check_intervals
      WHERE is_active = 1
      ORDER BY sort_order, minutes
    `)
    .all();

  const intervals = result.results as Array<{
    id: number;
    name: string;
    minutes: number;
  }>;

  if (intervals.length === 0) {
    await sendMessage(
      env,
      chatId,
      "There are no active check intervals configured.\n\n" +
      "Please add one under Settings → Check Intervals.",
      [
        [
          {
            text: "⏱ Intervals",
            callback_data: "settings:intervals",
          },
        ],
        [
          {
            text: "❌ Cancel",
            callback_data: "route:cancel",
          },
        ],
      ],
    );

    return;
  }

  await setConversationState(
    env,
    telegramUserId,
    "route:add:interval",
    data,
  );

  const keyboard: Keyboard =
    intervals.map((interval) => [
      {
        text:
          interval.name +
          " (" +
          interval.minutes +
          " min)",
        callback_data:
          "route:interval:" +
          interval.id,
      },
    ]);

  keyboard.push([
    {
      text: "❌ Cancel",
      callback_data: "route:cancel",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "➕ Add Route\n\n" +
    "Step 5 of 5\n\n" +
    "How often should this route be checked?",
    keyboard,
  );
}

/* ============================================================
   ROUTES
   ============================================================ */

async function showMyRoutes(
  env: Env,
  chatId: number,
  telegramUserId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        r.id,
        r.flight_date,
        r.jalali_date,
        r.is_active,
        o.name AS origin_name,
        o.airport_code AS origin_code,
        d.name AS destination_name,
        d.airport_code AS destination_code,
        ci.name AS interval_name,
        ci.minutes
      FROM routes r
      INNER JOIN users u
        ON u.id = r.user_id
      INNER JOIN origins o
        ON o.id = r.origin_id
      INNER JOIN destinations d
        ON d.id = r.destination_id
      INNER JOIN check_intervals ci
        ON ci.id = r.check_interval_id
      WHERE u.telegram_user_id = ?
      ORDER BY r.flight_date, r.id
    `)
    .bind(telegramUserId)
    .all();

  const routes = result.results as Array<{
    id: number;
    flight_date: string;
    jalali_date: string;
    is_active: number;
    origin_name: string;
    origin_code: string;
    destination_name: string;
    destination_code: string;
    interval_name: string;
    minutes: number;
  }>;

  if (routes.length === 0) {
    await sendMessage(
      env,
      chatId,
      "📋 My Routes\n\n" +
      "You don't have any routes yet.",
      [
        [
          {
            text: "➕ Add Route",
            callback_data: "menu:add_route",
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

    return;
  }

  const keyboard: Keyboard = [];

  for (const route of routes) {
    keyboard.push([
      {
        text:
          (route.is_active
            ? "🟢 "
            : "🔴 ") +
          route.origin_code +
          " → " +
          route.destination_code +
          " | " +
          route.jalali_date,
        callback_data:
          "route:view:" +
          route.id,
      },
    ]);
  }

  keyboard.push([
    {
      text: "➕ Add Route",
      callback_data: "menu:add_route",
    },
  ]);

  keyboard.push([
    {
      text: "⬅️ Main Menu",
      callback_data: "menu:main",
    },
  ]);

  await sendMessage(
    env,
    chatId,
    "📋 My Routes\n\n" +
    "🟢 = Active\n" +
    "🔴 = Disabled\n\n" +
    "Tap a route for details.",
    keyboard,
  );
}

async function showRouteDetails(
  env: Env,
  chatId: number,
  routeId: number,
  telegramUserId: number,
): Promise<void> {
  const route = await env.DB
    .prepare(`
      SELECT
        r.id,
        r.flight_date,
        r.jalali_date,
        r.is_active,
        r.last_checked_at,
        r.next_check_at,
        o.name AS origin_name,
        o.airport_code AS origin_code,
        d.name AS destination_name,
        d.airport_code AS destination_code,
        ci.name AS interval_name,
        ci.minutes
      FROM routes r
      INNER JOIN users u
        ON u.id = r.user_id
      INNER JOIN origins o
        ON o.id = r.origin_id
      INNER JOIN destinations d
        ON d.id = r.destination_id
      INNER JOIN check_intervals ci
        ON ci.id = r.check_interval_id
      WHERE r.id = ?
        AND u.telegram_user_id = ?
    `)
    .bind(
      routeId,
      telegramUserId,
    )
    .first<{
      id: number;
      flight_date: string;
      jalali_date: string;
      is_active: number;
      last_checked_at: string | null;
      next_check_at: string | null;
      origin_name: string;
      origin_code: string;
      destination_name: string;
      destination_code: string;
      interval_name: string;
      minutes: number;
    }>();

  if (!route) {
    await sendMessage(
      env,
      chatId,
      "Route not found.",
      [
        [
          {
            text: "⬅️ My Routes",
            callback_data: "menu:routes",
          },
        ],
      ],
    );

    return;
  }

  const status =
    route.is_active
      ? "🟢 Active"
      : "🔴 Disabled";

  await sendMessage(
    env,
    chatId,
    "✈️ Route\n\n" +
    route.origin_name +
    " (" +
    route.origin_code +
    ")\n" +
    "→ " +
    route.destination_name +
    " (" +
    route.destination_code +
    ")\n\n" +
    "📅 Shamsi date: " +
    route.jalali_date +
    "\n" +
    "📅 Gregorian date: " +
    route.flight_date +
    "\n\n" +
    "⏱ Interval: " +
    route.interval_name +
    " (" +
    route.minutes +
    " min)\n\n" +
    status +
    "\n\n" +
    "Last checked: " +
    (route.last_checked_at ?? "Never"),
    [
      [
        {
          text:
            route.is_active
              ? "🔴 Disable"
              : "🟢 Enable",
          callback_data:
            "route:toggle:" +
            route.id,
        },
        {
          text: "🔍 Check Now",
          callback_data:
            "route:check:" +
            route.id,
        },
      ],
      [
        {
          text: "⬅️ My Routes",
          callback_data: "menu:routes",
        },
      ],
    ],
  );
}

/* ============================================================
   CHECK ROUTE
   ============================================================ */

async function queueRouteCheck(
  env: Env,
  chatId: number,
  routeId: number,
  telegramUserId: number,
): Promise<void> {
  const route = await env.DB
    .prepare(`
      SELECT r.id
      FROM routes r
      INNER JOIN users u
        ON u.id = r.user_id
      WHERE r.id = ?
        AND u.telegram_user_id = ?
        AND r.is_active = 1
    `)
    .bind(
      routeId,
      telegramUserId,
    )
    .first<{ id: number }>();

  if (!route) {
    await sendMessage(
      env,
      chatId,
      "⚠️ This route does not exist or is disabled.",
      [
        [
          {
            text: "⬅️ My Routes",
            callback_data: "menu:routes",
          },
        ],
      ],
    );

    return;
  }

  const websites = await env.DB
    .prepare(`
      SELECT website_id
      FROM route_websites
      WHERE route_id = ?
    `)
    .bind(routeId)
    .all();

  if (websites.results.length === 0) {
    await sendMessage(
      env,
      chatId,
      "⚠️ This route has no ticket websites assigned.",
      [
        [
          {
            text: "⬅️ My Routes",
            callback_data: "menu:routes",
          },
        ],
      ],
    );

    return;
  }

  let created = 0;

  for (const row of websites.results as Array<{
    website_id: number;
  }>) {
    const existing = await env.DB
      .prepare(`
        SELECT id
        FROM scraping_jobs
        WHERE route_id = ?
          AND website_id = ?
          AND status = 'pending'
        LIMIT 1
      `)
      .bind(
        routeId,
        row.website_id,
      )
      .first();

    if (!existing) {
      await env.DB
        .prepare(`
          INSERT INTO scraping_jobs (
            route_id,
            website_id,
            status,
            requested_at,
            attempt_count
          )
          VALUES (
            ?,
            ?,
            'pending',
            CURRENT_TIMESTAMP,
            0
          )
        `)
        .bind(
          routeId,
          row.website_id,
        )
        .run();

      created++;
    }
  }

  await env.DB
    .prepare(`
      UPDATE routes
      SET
        last_checked_at = CURRENT_TIMESTAMP,
        next_check_at = datetime(
          'now',
          '+' ||
          (
            SELECT minutes
            FROM check_intervals
            WHERE id = routes.check_interval_id
          ) ||
          ' minutes'
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(routeId)
    .run();

  await sendMessage(
    env,
    chatId,
    "🔍 Check requested.\n\n" +
    created +
    " scraping job(s) queued.\n\n" +
    "The scraping worker will process them.",
    [
      [
        {
          text: "📊 Results",
          callback_data: "menu:results",
        },
      ],
      [
        {
          text: "⬅️ My Routes",
          callback_data: "menu:routes",
        },
      ],
    ],
  );
}

/* ============================================================
   RESULTS
   ============================================================ */

async function showResults(
  env: Env,
  chatId: number,
  telegramUserId: number,
): Promise<void> {
  const result = await env.DB
    .prepare(`
      SELECT
        fr.id,
        fr.airline,
        fr.flight_number,
        fr.departure_time,
        fr.arrival_time,
        fr.duration_minutes,
        fr.stops,
        fr.available_seats,
        fr.cabin_class,
        fr.currency,
        fr.price,
        fr.booking_url,
        fr.scraped_at,
        o.airport_code AS origin_code,
        d.airport_code AS destination_code,
        w.name AS website_name
      FROM flight_results fr
      INNER JOIN routes r
        ON r.id = fr.route_id
      INNER JOIN users u
        ON u.id = r.user_id
      INNER JOIN origins o
        ON o.id = r.origin_id
      INNER JOIN destinations d
        ON d.id = r.destination_id
      INNER JOIN websites w
        ON w.id = fr.website_id
      WHERE u.telegram_user_id = ?
      ORDER BY fr.scraped_at DESC
      LIMIT 20
    `)
    .bind(telegramUserId)
    .all();

  const results = result.results as Array<{
    id: number;
    airline: string | null;
    flight_number: string | null;
    departure_time: string | null;
    arrival_time: string | null;
    duration_minutes: number | null;
    stops: number | null;
    available_seats: number | null;
    cabin_class: string | null;
    currency: string | null;
    price: number | null;
    booking_url: string | null;
    scraped_at: string;
    origin_code: string;
    destination_code: string;
    website_name: string;
  }>;

  if (results.length === 0) {
    await sendMessage(
      env,
      chatId,
      "📊 Results\n\n" +
      "No flight results are available yet.\n\n" +
      "Use Check Route to create a scraping job.",
      [
        [
          {
            text: "🔍 Check Route",
            callback_data: "menu:check",
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

    return;
  }

  let text =
    "📊 Latest Flight Results\n\n";

  for (const result of results) {
    text +=
      "✈️ " +
      result.origin_code +
      " → " +
      result.destination_code +
      "\n";

    if (result.airline) {
      text +=
        "Airline: " +
        result.airline +
        "\n";
    }

    if (result.flight_number) {
      text +=
        "Flight: " +
        result.flight_number +
        "\n";
    }

    if (result.departure_time) {
      text +=
        "Departure: " +
        result.departure_time +
        "\n";
    }

    if (result.arrival_time) {
      text +=
        "Arrival: " +
        result.arrival_time +
        "\n";
    }

    if (result.price !== null) {
      text +=
        "💰 Price: " +
        result.price +
        " " +
        (result.currency ?? "") +
        "\n";
    }

    if (result.available_seats !== null) {
      text +=
        "💺 Seats: " +
        result.available_seats +
        "\n";
    }

    text +=
      "🌐 " +
      result.website_name +
      "\n" +
      "🕒 " +
      result.scraped_at +
      "\n\n";
  }

  await sendMessage(
    env,
    chatId,
    text,
    [
      [
        {
          text: "🔄 Refresh",
          callback_data: "menu:results",
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
}

/* ============================================================
   TEXT INPUT HANDLER
   ============================================================ */

async function handleTextInput(
  env: Env,
  message: TelegramMessage,
): Promise<boolean> {
  const user = message.from;

  if (!user || !message.text) {
    return false;
  }

  const text =
    message.text.trim();

  const state =
    await getConversationState(
      env,
      user.id,
    );

  if (!state || state.state === "idle") {
    return false;
  }

  const chatId =
    message.chat.id;

  /* -----------------------------
     ADD ORIGIN
     ----------------------------- */

  if (state.state === "origin:add:name") {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid airport or city name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "origin:add:name_fa",
      {
        name: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 2 of 3\n\n" +
      "Please type the Persian name.\n\n" +
      "Example:\n" +
      "تهران",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return true;
  }

  if (state.state === "origin:add:name_fa") {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid Persian name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "origin:add:code",
      {
        ...state.data,
        name_fa: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 3 of 3\n\n" +
      "Please type the 3-letter IATA airport code.\n\n" +
      "Example:\n" +
      "IKA",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return true;
  }

  if (state.state === "origin:add:code") {
    const code =
      text.toUpperCase();

    if (!/^[A-Z]{3}$/.test(code)) {
      await sendMessage(
        env,
        chatId,
        "⚠️ The airport code must contain exactly 3 English letters.\n\n" +
        "Example: IKA",
      );

      return true;
    }

    const existing = await env.DB
      .prepare(`
        SELECT id
        FROM origins
        WHERE airport_code = ?
      `)
      .bind(code)
      .first();

    if (existing) {
      await sendMessage(
        env,
        chatId,
        "⚠️ An origin with this airport code already exists.",
        [
          [
            {
              text: "🌍 Back to Origins",
              callback_data: "settings:origins",
            },
          ],
        ],
      );

      await clearConversationState(
        env,
        user.id,
      );

      return true;
    }

    await env.DB
      .prepare(`
        INSERT INTO origins (
          name,
          name_fa,
          airport_code,
          is_active,
          sort_order
        )
        VALUES (?, ?, ?, 1, 0)
      `)
      .bind(
        state.data.name,
        state.data.name_fa,
        code,
      )
      .run();

    await clearConversationState(
      env,
      user.id,
    );

    await sendMessage(
      env,
      chatId,
      "✅ Origin added successfully!\n\n" +
      state.data.name +
      " (" +
      code +
      ")",
      [
        [
          {
            text: "🌍 Origins",
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

    return true;
  }

  /* -----------------------------
     ADD DESTINATION
     ----------------------------- */

  if (
    state.state ===
    "destination:add:name"
  ) {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid airport or city name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "destination:add:name_fa",
      {
        name: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 2 of 3\n\n" +
      "Please type the Persian name.",
    );

    return true;
  }

  if (
    state.state ===
    "destination:add:name_fa"
  ) {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid Persian name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "destination:add:code",
      {
        ...state.data,
        name_fa: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 3 of 3\n\n" +
      "Please type the 3-letter IATA airport code.",
    );

    return true;
  }

  if (
    state.state ===
    "destination:add:code"
  ) {
    const code =
      text.toUpperCase();

    if (!/^[A-Z]{3}$/.test(code)) {
      await sendMessage(
        env,
        chatId,
        "⚠️ The airport code must contain exactly 3 English letters.",
      );

      return true;
    }

    const existing = await env.DB
      .prepare(`
        SELECT id
        FROM destinations
        WHERE airport_code = ?
      `)
      .bind(code)
      .first();

    if (existing) {
      await sendMessage(
        env,
        chatId,
        "⚠️ A destination with this airport code already exists.",
      );

      await clearConversationState(
        env,
        user.id,
      );

      return true;
    }

    await env.DB
      .prepare(`
        INSERT INTO destinations (
          name,
          name_fa,
          airport_code,
          is_active,
          sort_order
        )
        VALUES (?, ?, ?, 1, 0)
      `)
      .bind(
        state.data.name,
        state.data.name_fa,
        code,
      )
      .run();

    await clearConversationState(
      env,
      user.id,
    );

    await sendMessage(
      env,
      chatId,
      "✅ Destination added successfully!\n\n" +
      state.data.name +
      " (" +
      code +
      ")",
      [
        [
          {
            text: "📍 Destinations",
            callback_data: "settings:destinations",
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

    return true;
  }

  /* -----------------------------
     ADD WEBSITE
     ----------------------------- */

  if (
    state.state ===
    "website:add:name"
  ) {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid website name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "website:add:url",
      {
        name: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 2 of 3\n\n" +
      "Please type the website base URL.\n\n" +
      "Example:\n" +
      "https://example.com",
    );

    return true;
  }

  if (
    state.state ===
    "website:add:url"
  ) {
    if (
      !/^https?:\/\/.+/i.test(text)
    ) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a valid URL beginning with http:// or https://",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "website:add:key",
      {
        ...state.data,
        base_url: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 3 of 3\n\n" +
      "Please enter a unique scraper key.\n\n" +
      "Example:\n" +
      "website_example",
    );

    return true;
  }

  if (
    state.state ===
    "website:add:key"
  ) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(text)
    ) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Use only English letters, numbers, underscore or hyphen.",
      );

      return true;
    }

    try {
      await env.DB
        .prepare(`
          INSERT INTO websites (
            name,
            base_url,
            scraper_key,
            is_active,
            sort_order
          )
          VALUES (?, ?, ?, 1, 0)
        `)
        .bind(
          state.data.name,
          state.data.base_url,
          text,
        )
        .run();
    } catch {
      await sendMessage(
        env,
        chatId,
        "⚠️ This website name or scraper key already exists.",
      );

      await clearConversationState(
        env,
        user.id,
      );

      return true;
    }

    await clearConversationState(
      env,
      user.id,
    );

    await sendMessage(
      env,
      chatId,
      "✅ Website added successfully.",
      [
        [
          {
            text: "🌐 Websites",
            callback_data: "settings:websites",
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

    return true;
  }

  /* -----------------------------
     ADD INTERVAL
     ----------------------------- */

  if (
    state.state ===
    "interval:add:name"
  ) {
    if (text.length < 2) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter an interval name.",
      );

      return true;
    }

    await setConversationState(
      env,
      user.id,
      "interval:add:minutes",
      {
        name: text,
      },
    );

    await sendMessage(
      env,
      chatId,
      "Step 2 of 2\n\n" +
      "Please enter the interval in minutes.\n\n" +
      "Examples:\n" +
      "5\n" +
      "15\n" +
      "60",
    );

    return true;
  }

  if (
    state.state ===
    "interval:add:minutes"
  ) {
    const minutes =
      Number(text);

    if (
      !Number.isInteger(minutes) ||
      minutes <= 0
    ) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please enter a positive whole number of minutes.",
      );

      return true;
    }

    try {
      await env.DB
        .prepare(`
          INSERT INTO check_intervals (
            name,
            minutes,
            is_active,
            sort_order
          )
          VALUES (?, ?, 1, 0)
        `)
        .bind(
          state.data.name,
          minutes,
        )
        .run();
    } catch {
      await sendMessage(
        env,
        chatId,
        "⚠️ An interval with this name or minute value already exists.",
      );

      await clearConversationState(
        env,
        user.id,
      );

      return true;
    }

    await clearConversationState(
      env,
      user.id,
    );

    await sendMessage(
      env,
      chatId,
      "✅ Check interval added successfully.",
      [
        [
          {
            text: "⏱ Intervals",
            callback_data: "settings:intervals",
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

    return true;
  }

  return false;
}

/* ============================================================
   BUTTON HANDLER
   ============================================================ */

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

  const telegramUserId =
    callbackQuery.from.id;

  /* ==========================================================
     MAIN MENU
     ========================================================== */

  if (data === "menu:main") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showMainMenu(
      env,
      chatId,
      callbackQuery.from.first_name,
    );

    return;
  }

  if (data === "menu:settings") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showSettingsMenu(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     ADD ROUTE
     ========================================================== */

  if (data === "menu:add_route") {
    await startAddRoute(
      env,
      chatId,
      telegramUserId,
    );

    return;
  }

  if (data === "route:cancel") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await sendMessage(
      env,
      chatId,
      "❌ Route creation cancelled.",
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

  if (data === "input:cancel") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await sendMessage(
      env,
      chatId,
      "❌ Operation cancelled.",
      [
        [
          {
            text: "⬅️ Settings",
            callback_data: "menu:settings",
          },
        ],
      ],
    );

    return;
  }

  if (data === "noop") {
    return;
  }

  if (data.startsWith("route:origin:")) {
    const originId =
      Number(data.split(":")[2]);

    if (!Number.isInteger(originId)) {
      return;
    }

    await showDestinationSelection(
      env,
      chatId,
      telegramUserId,
      originId,
    );

    return;
  }

  if (
    data.startsWith(
      "route:destination:",
    )
  ) {
    const destinationId =
      Number(data.split(":")[2]);

    const state =
      await getConversationState(
        env,
        telegramUserId,
      );

    if (
      !state ||
      state.state !==
        "route:add:destination"
    ) {
      return;
    }

    const originId =
      Number(state.data.origin_id);

    await setConversationState(
      env,
      telegramUserId,
      "route:add:date",
      {
        origin_id: originId,
        destination_id:
          destinationId,
      },
    );

    const jalali =
      currentJalali();

    await showJalaliCalendar(
      env,
      chatId,
      jalali.year,
      jalali.month,
    );

    return;
  }

  if (data.startsWith("route:cal:")) {
    const parts =
      data.split(":");

    const year =
      Number(parts[2]);

    const month =
      Number(parts[3]);

    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month)
    ) {
      return;
    }

    await showJalaliCalendar(
      env,
      chatId,
      year,
      month,
    );

    return;
  }

  if (data.startsWith("route:date:")) {
    const parts =
      data.split(":");

    const gregorian =
      parts[2];

    const jalaliYear =
      Number(parts[3]);

    const jalaliMonth =
      Number(parts[4]);

    const jalaliDay =
      Number(parts[5]);

    const state =
      await getConversationState(
        env,
        telegramUserId,
      );

    if (!state) {
      return;
    }

    await showWebsiteSelection(
      env,
      chatId,
      telegramUserId,
      {
        ...state.data,
        flight_date:
          gregorian,
        jalali_date:
          String(jalaliYear) +
          "/" +
          String(jalaliMonth).padStart(2, "0") +
          "/" +
          String(jalaliDay).padStart(2, "0"),
      },
    );

    return;
  }

  if (
    data.startsWith(
      "route:website:",
    )
  ) {
    const websiteId =
      Number(data.split(":")[2]);

    const state =
      await getConversationState(
        env,
        telegramUserId,
      );

    if (
      !state ||
      state.state !==
        "route:add:websites"
    ) {
      return;
    }

    const selected =
      Array.isArray(
        state.data.website_ids,
      )
        ? state.data.website_ids as number[]
        : [];

    const index =
      selected.indexOf(
        websiteId,
      );

    if (index >= 0) {
      selected.splice(index, 1);
    } else {
      selected.push(websiteId);
    }

    await showWebsiteSelection(
      env,
      chatId,
      telegramUserId,
      {
        ...state.data,
        website_ids: selected,
      },
    );

    return;
  }

  if (
    data ===
    "route:websites:done"
  ) {
    const state =
      await getConversationState(
        env,
        telegramUserId,
      );

    if (!state) {
      return;
    }

    const selected =
      Array.isArray(
        state.data.website_ids,
      )
        ? state.data.website_ids as number[]
        : [];

    if (selected.length === 0) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Please select at least one ticket website.",
      );

      return;
    }

    await showIntervalSelection(
      env,
      chatId,
      telegramUserId,
      state.data,
    );

    return;
  }

  if (
    data.startsWith(
      "route:interval:",
    )
  ) {
    const intervalId =
      Number(data.split(":")[2]);

    const state =
      await getConversationState(
        env,
        telegramUserId,
      );

    if (!state) {
      return;
    }

    const user = await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE telegram_user_id = ?
      `)
      .bind(telegramUserId)
      .first<{ id: number }>();

    if (!user) {
      return;
    }

    const websiteIds =
      Array.isArray(
        state.data.website_ids,
      )
        ? state.data.website_ids as number[]
        : [];

    if (websiteIds.length === 0) {
      return;
    }

    const route = await env.DB
      .prepare(`
        INSERT INTO routes (
          user_id,
          origin_id,
          destination_id,
          flight_date,
          jalali_date,
          check_interval_id,
          is_active,
          next_check_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          1,
          datetime(
            'now',
            '+' ||
            (
              SELECT minutes
              FROM check_intervals
              WHERE id = ?
            ) ||
            ' minutes'
          )
        )
        RETURNING id
      `)
      .bind(
        user.id,
        state.data.origin_id,
        state.data.destination_id,
        state.data.flight_date,
        state.data.jalali_date,
        intervalId,
        intervalId,
      )
      .first<{ id: number }>();

    if (!route) {
      await sendMessage(
        env,
        chatId,
        "⚠️ Could not create the route.",
      );

      return;
    }

    for (
      const websiteId of websiteIds
    ) {
      await env.DB
        .prepare(`
          INSERT INTO route_websites (
            route_id,
            website_id
          )
          VALUES (?, ?)
        `)
        .bind(
          route.id,
          websiteId,
        )
        .run();
    }

    await clearConversationState(
      env,
      telegramUserId,
    );

    await sendMessage(
      env,
      chatId,
      "✅ Route created successfully!\n\n" +
      "Your route is now active and ready for checking.",
      [
        [
          {
            text: "📋 My Routes",
            callback_data: "menu:routes",
          },
        ],
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

  /* ==========================================================
     MY ROUTES
     ========================================================== */

  if (data === "menu:routes") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showMyRoutes(
      env,
      chatId,
      telegramUserId,
    );

    return;
  }

  if (data.startsWith("route:view:")) {
    const routeId =
      Number(data.split(":")[2]);

    await showRouteDetails(
      env,
      chatId,
      routeId,
      telegramUserId,
    );

    return;
  }

  if (data.startsWith("route:toggle:")) {
    const routeId =
      Number(data.split(":")[2]);

    await env.DB
      .prepare(`
        UPDATE routes
        SET
          is_active =
            CASE
              WHEN is_active = 1 THEN 0
              ELSE 1
            END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT r.id
          FROM routes r
          INNER JOIN users u
            ON u.id = r.user_id
          WHERE r.id = ?
            AND u.telegram_user_id = ?
        )
      `)
      .bind(
        routeId,
        telegramUserId,
      )
      .run();

    await showMyRoutes(
      env,
      chatId,
      telegramUserId,
    );

    return;
  }

  if (data.startsWith("route:check:")) {
    const routeId =
      Number(data.split(":")[2]);

    await queueRouteCheck(
      env,
      chatId,
      routeId,
      telegramUserId,
    );

    return;
  }

  /* ==========================================================
     CHECK ROUTE MENU
     ========================================================== */

  if (data === "menu:check") {
    const result = await env.DB
      .prepare(`
        SELECT
          r.id,
          o.airport_code AS origin_code,
          d.airport_code AS destination_code,
          r.jalali_date
        FROM routes r
        INNER JOIN users u
          ON u.id = r.user_id
        INNER JOIN origins o
          ON o.id = r.origin_id
        INNER JOIN destinations d
          ON d.id = r.destination_id
        WHERE u.telegram_user_id = ?
          AND r.is_active = 1
        ORDER BY r.flight_date
      `)
      .bind(telegramUserId)
      .all();

    const routes = result.results as Array<{
      id: number;
      origin_code: string;
      destination_code: string;
      jalali_date: string;
    }>;

    if (routes.length === 0) {
      await sendMessage(
        env,
        chatId,
        "🔍 Check Route\n\n" +
        "You don't have any active routes.",
        [
          [
            {
              text: "➕ Add Route",
              callback_data: "menu:add_route",
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

      return;
    }

    const keyboard: Keyboard =
      routes.map((route) => [
        {
          text:
            route.origin_code +
            " → " +
            route.destination_code +
            " | " +
            route.jalali_date,
          callback_data:
            "route:check:" +
            route.id,
        },
      ]);

    keyboard.push([
      {
        text: "⬅️ Main Menu",
        callback_data: "menu:main",
      },
    ]);

    await sendMessage(
      env,
      chatId,
      "🔍 Check Route\n\n" +
      "Select a route to check:",
      keyboard,
    );

    return;
  }

  /* ==========================================================
     RESULTS
     ========================================================== */

  if (data === "menu:results") {
    await showResults(
      env,
      chatId,
      telegramUserId,
    );

    return;
  }

  /* ==========================================================
     SETTINGS
     ========================================================== */

  if (data === "settings:origins") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showOrigins(
      env,
      chatId,
    );

    return;
  }

  if (data === "settings:destinations") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showDestinations(
      env,
      chatId,
    );

    return;
  }

  if (data === "settings:websites") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showWebsites(
      env,
      chatId,
    );

    return;
  }

  if (data === "settings:intervals") {
    await clearConversationState(
      env,
      telegramUserId,
    );

    await showIntervals(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     ORIGIN ADD
     ========================================================== */

  if (data === "origin:add") {
    await setConversationState(
      env,
      telegramUserId,
      "origin:add:name",
    );

    await sendMessage(
      env,
      chatId,
      "➕ Add Origin\n\n" +
      "Step 1 of 3\n\n" +
      "Please type the airport or city name.\n\n" +
      "Example:\n" +
      "Tehran",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return;
  }

  if (data.startsWith("origin:toggle:")) {
    const id =
      Number(data.split(":")[2]);

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
      .bind(id)
      .run();

    await showOrigins(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     DESTINATION ADD
     ========================================================== */

  if (data === "destination:add") {
    await setConversationState(
      env,
      telegramUserId,
      "destination:add:name",
    );

    await sendMessage(
      env,
      chatId,
      "➕ Add Destination\n\n" +
      "Step 1 of 3\n\n" +
      "Please type the airport or city name.\n\n" +
      "Example:\n" +
      "Istanbul",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return;
  }

  if (
    data.startsWith(
      "destination:toggle:",
    )
  ) {
    const id =
      Number(data.split(":")[2]);

    await env.DB
      .prepare(`
        UPDATE destinations
        SET
          is_active =
            CASE
              WHEN is_active = 1 THEN 0
              ELSE 1
            END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(id)
      .run();

    await showDestinations(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     WEBSITE ADD
     ========================================================== */

  if (data === "website:add") {
    await setConversationState(
      env,
      telegramUserId,
      "website:add:name",
    );

    await sendMessage(
      env,
      chatId,
      "➕ Add Ticket Website\n\n" +
      "Step 1 of 3\n\n" +
      "Enter the website name.\n\n" +
      "Example:\n" +
      "Example Tickets",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return;
  }

  if (
    data.startsWith(
      "website:toggle:",
    )
  ) {
    const id =
      Number(data.split(":")[2]);

    await env.DB
      .prepare(`
        UPDATE websites
        SET
          is_active =
            CASE
              WHEN is_active = 1 THEN 0
              ELSE 1
            END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(id)
      .run();

    await showWebsites(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     INTERVAL ADD
     ========================================================== */

  if (data === "interval:add") {
    await setConversationState(
      env,
      telegramUserId,
      "interval:add:name",
    );

    await sendMessage(
      env,
      chatId,
      "➕ Add Check Interval\n\n" +
      "Step 1 of 2\n\n" +
      "Enter a name.\n\n" +
      "Example:\n" +
      "Every 15 minutes",
      [
        [
          {
            text: "❌ Cancel",
            callback_data: "input:cancel",
          },
        ],
      ],
    );

    return;
  }

  if (
    data.startsWith(
      "interval:toggle:",
    )
  ) {
    const id =
      Number(data.split(":")[2]);

    await env.DB
      .prepare(`
        UPDATE check_intervals
        SET
          is_active =
            CASE
              WHEN is_active = 1 THEN 0
              ELSE 1
            END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(id)
      .run();

    await showIntervals(
      env,
      chatId,
    );

    return;
  }

  /* ==========================================================
     NOTIFICATIONS
     ========================================================== */

  if (
    data ===
    "settings:notifications"
  ) {
    const setting =
      await env.DB
        .prepare(`
          SELECT
            us.notifications_enabled
          FROM user_settings us
          INNER JOIN users u
            ON u.id = us.user_id
          WHERE u.telegram_user_id = ?
        `)
        .bind(telegramUserId)
        .first<{
          notifications_enabled: number;
        }>();

    const enabled =
      setting?.notifications_enabled === 1;

    await sendMessage(
      env,
      chatId,
      "🔔 Notifications\n\n" +
      "Notifications are currently " +
      (enabled
        ? "🟢 ON"
        : "🔴 OFF") +
      ".",
      [
        [
          {
            text:
              enabled
                ? "🔴 Turn OFF"
                : "🟢 Turn ON",
            callback_data:
              "settings:notifications:toggle",
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

    return;
  }

  if (
    data ===
    "settings:notifications:toggle"
  ) {
    await env.DB
      .prepare(`
        UPDATE user_settings
        SET
          notifications_enabled =
            CASE
              WHEN notifications_enabled = 1
              THEN 0
              ELSE 1
            END,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = (
          SELECT id
          FROM users
          WHERE telegram_user_id = ?
        )
      `)
      .bind(telegramUserId)
      .run();

    await sendMessage(
      env,
      chatId,
      "✅ Notification setting updated.",
      [
        [
          {
            text: "🔔 Notifications",
            callback_data:
              "settings:notifications",
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

    return;
  }

  /* ==========================================================
     LANGUAGE
     ========================================================== */

  if (
    data ===
    "settings:language"
  ) {
    const setting =
      await env.DB
        .prepare(`
          SELECT
            us.language
          FROM user_settings us
          INNER JOIN users u
            ON u.id = us.user_id
          WHERE u.telegram_user_id = ?
        `)
        .bind(telegramUserId)
        .first<{
          language: string;
        }>();

    await sendMessage(
      env,
      chatId,
      "🌐 Language\n\n" +
      "Current language: " +
      (setting?.language ?? "en") +
      "\n\n" +
      "Language selection is prepared for future multilingual bot support.",
      [
        [
          {
            text: "🇬🇧 English",
            callback_data:
              "language:set:en",
          },
          {
            text: "🇮🇷 فارسی",
            callback_data:
              "language:set:fa",
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

    return;
  }

  if (
    data.startsWith(
      "language:set:",
    )
  ) {
    const language =
      data.split(":")[2];

    if (
      language !== "en" &&
      language !== "fa"
    ) {
      return;
    }

    await env.DB
      .prepare(`
        UPDATE user_settings
        SET
          language = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = (
          SELECT id
          FROM users
          WHERE telegram_user_id = ?
        )
      `)
      .bind(
        language,
        telegramUserId,
      )
      .run();

    await sendMessage(
      env,
      chatId,
      "✅ Language preference saved as " +
      language +
      ".\n\n" +
      "Full Persian interface translation can be added later.",
      [
        [
          {
            text: "⬅️ Settings",
            callback_data: "menu:settings",
          },
        ],
      ],
    );

    return;
  }

  /* ==========================================================
     UNKNOWN BUTTON
     ========================================================== */

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
}

/* ============================================================
   TELEGRAM UPDATE HANDLER
   ============================================================ */

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
      if (user) {
        await clearConversationState(
          env,
          user.id,
        );
      }

      await showMainMenu(
        env,
        chatId,
        user?.first_name,
      );

      return;
    }

    if (user) {
      const handled =
        await handleTextInput(
          env,
          update.message,
        );

      if (handled) {
        return;
      }
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

/* ============================================================
   WORKER
   ============================================================ */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url =
      new URL(request.url);

    /* -----------------------------------------
       HEALTH CHECK
       ----------------------------------------- */

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        "✈️ Flight Tracker Bot is alive!",
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain; charset=UTF-8",
          },
        },
      );
    }

    /* -----------------------------------------
       TELEGRAM WEBHOOK
       ----------------------------------------- */

    if (
      request.method === "POST" &&
      url.pathname ===
        "/telegram/webhook"
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

    /* -----------------------------------------
       WEBHOOK SETUP
       ----------------------------------------- */

    if (
      request.method === "GET" &&
      url.pathname ===
        "/setup-webhook"
    ) {
      const key =
        url.searchParams.get("key");

      if (
        !key ||
        key !==
          env.TELEGRAM_WEBHOOK_SECRET
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
