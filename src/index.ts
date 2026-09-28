interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name?: string; username?: string };
  data?: string;
  message?: TgMessage;
}

interface ConversationState {
  state: string;
  data: Record<string, any>;
}

const MAIN_MENU: Keyboard = [
  [{ text: "✈️ Add Route", callback_data: "menu:add_route" }],
  [{ text: "📋 My Routes", callback_data: "menu:routes" }],
  [{ text: "🔍 Check Now", callback_data: "menu:check" }],
  [{ text: "📊 Results", callback_data: "menu:results" }],
  [{ text: "⚙️ Settings", callback_data: "menu:settings" }],
];

const BACK_MAIN: Keyboard = [[{ text: "⬅️ Main Menu", callback_data: "menu:main" }]];

async function telegramApi<T = any>(
  env: Env,
  method: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parameters),
    },
  );

  const body = await response.json() as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (!body.ok) {
    throw new Error(`Telegram ${method}: ${body.description ?? "unknown error"}`);
  }

  return body.result as T;
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<number> {
  const parameters: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (keyboard) {
    parameters.reply_markup = { inline_keyboard: keyboard };
  }

  const message = await telegramApi<TgMessage>(env, "sendMessage", parameters);
  return message.message_id;
}

async function editMessage(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<boolean> {
  const parameters: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (keyboard) {
    parameters.reply_markup = { inline_keyboard: keyboard };
  }

  try {
    await telegramApi(env, "editMessageText", parameters);
    return true;
  } catch (error) {
    if (String(error).toLowerCase().includes("message is not modified")) {
      return true;
    }
    return false;
  }
}

async function answerCallbackQuery(env: Env, id: string, text?: string): Promise<void> {
  const parameters: Record<string, unknown> = { callback_query_id: id };
  if (text) parameters.text = text;
  await telegramApi(env, "answerCallbackQuery", parameters);
}

async function getConversationState(
  env: Env,
  telegramUserId: number,
): Promise<ConversationState | null> {
  const row = await env.DB.prepare(
    "SELECT state, data FROM conversation_states WHERE user_id = ?",
  ).bind(telegramUserId).first<{ state: string; data: string | null }>();

  if (!row) return null;

  let data: Record<string, any> = {};
  if (row.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = {};
    }
  }

  return { state: row.state, data };
}

async function setConversationState(
  env: Env,
  telegramUserId: number,
  state: string,
  data: Record<string, any> = {},
): Promise<void> {
  const current = await getConversationState(env, telegramUserId);
  const uiMessageId = current?.data?.ui_message_id;

  const nextData = { ...data };
  if (uiMessageId) nextData.ui_message_id = uiMessageId;

  await env.DB.prepare(`
    INSERT INTO conversation_states (user_id, state, data, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      state = excluded.state,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    telegramUserId,
    state,
    JSON.stringify(nextData),
  ).run();
}

async function clearConversationState(
  env: Env,
  telegramUserId: number,
): Promise<void> {
  const current = await getConversationState(env, telegramUserId);
  const data = current?.data?.ui_message_id
    ? { ui_message_id: current.data.ui_message_id }
    : {};

  await setConversationState(env, telegramUserId, "idle", data);
}

async function setUiMessageId(
  env: Env,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const current = await getConversationState(env, telegramUserId);
  await setConversationState(
    env,
    telegramUserId,
    current?.state ?? "idle",
    { ...(current?.data ?? {}), ui_message_id: messageId },
  );
}

async function renderUi(
  env: Env,
  telegramUserId: number,
  chatId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<number> {
  const current = await getConversationState(env, telegramUserId);
  const oldMessageId = current?.data?.ui_message_id as number | undefined;

  if (oldMessageId) {
    const edited = await editMessage(env, chatId, oldMessageId, text, keyboard);
    if (edited) return oldMessageId;
  }

  const newMessageId = await sendMessage(env, chatId, text, keyboard);
  await setUiMessageId(env, telegramUserId, newMessageId);
  return newMessageId;
}

/* Reports are deliberately NOT rendered through renderUi().
   They create permanent messages and therefore remain as chat history. */
async function sendReportMessage(
  env: Env,
  chatId: number,
  text: string,
): Promise<number> {
  return sendMessage(env, chatId, text);
}

async function registerUser(env: Env, user: { id: number; first_name?: string; username?: string }): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_user_id, first_name, username)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username
  `).bind(
    user.id,
    user.first_name ?? "",
    user.username ?? null,
  ).run();

  await env.DB.prepare(`
    INSERT INTO user_settings (user_id, notifications_enabled, language)
    SELECT id, 1, 'en'
    FROM users
    WHERE telegram_user_id = ?
    ON CONFLICT(user_id) DO NOTHING
  `).bind(user.id).run();
}

async function showMainMenu(env: Env, userId: number, chatId: number): Promise<void> {
  await clearConversationState(env, userId);
  await renderUi(
    env,
    userId,
    chatId,
    "✈️ Flight Tracker Bot\n\nChoose an option:",
    MAIN_MENU,
  );
}

async function showSettings(env: Env, userId: number, chatId: number): Promise<void> {
  await renderUi(env, userId, chatId, "⚙️ Settings\n\nChoose what you want to manage:", [
    [{ text: "🛫 Origins", callback_data: "settings:origins" }],
    [{ text: "🛬 Destinations", callback_data: "settings:destinations" }],
    [{ text: "🌐 Ticket Websites", callback_data: "settings:websites" }],
    [{ text: "⏱ Check Intervals", callback_data: "settings:intervals" }],
    [{ text: "🔔 Notifications", callback_data: "settings:notifications" }],
    [{ text: "🌍 Language", callback_data: "settings:language" }],
    [{ text: "⬅️ Main Menu", callback_data: "menu:main" }],
  ]);
}

function isGregorianLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function jalaliToGregorian(jy: number, jm: number, jd: number): string {
  let gy = jy + 621;
  const jy2 = jy - (jy >= 0 ? 474 : 473);
  const cycle = 474 + (jy2 % 2820);
  const epBase = cycle + 38;
  const epYear = 474 + (epBase % 2820);
  const days =
    jd +
    (jm <= 7 ? (jm - 1) * 31 : (jm - 1) * 30 + 6) +
    Math.floor((epYear * 682 - 110) / 2816) +
    (epYear - 1) * 365 +
    Math.floor(jy2 / 2820) * 1029983 +
    1948320 - 1;

  let gday = days;
  let gy0 = Math.floor((gday - 1867216.25) / 36524.25);
  if (gday > 2299160) {
    gday += 1 + gy0 - Math.floor(gy0 / 4);
  }

  const b = gday + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const gd = b - d - Math.floor(30.6001 * e);
  const gm = e < 14 ? e - 1 : e - 13;
  gy = gm > 2 ? c - 4716 : c - 4715;

  return `${gy.toString().padStart(4, "0")}-${gm.toString().padStart(2, "0")}-${gd.toString().padStart(2, "0")}`;
}

function gregorianToJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gDaysInMonth = [31, isGregorianLeap(gy) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const jDaysInMonth = [31,31,31,31,31,31,30,30,30,30,30,29];

  let gy2 = gy - 1600;
  let gm2 = gm - 1;
  const gd2 = gd - 1;

  let gDayNo =
    365 * gy2 +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400);

  for (let i = 0; i < gm2; i++) gDayNo += gDaysInMonth[i];
  gDayNo += gd2;

  let jDayNo = gDayNo - 79;
  const jNp = Math.floor(jDayNo / 12053);
  jDayNo %= 12053;

  let jy = 979 + 33 * jNp + 4 * Math.floor(jDayNo / 1461);
  jDayNo %= 1461;

  if (jDayNo >= 366) {
    jy += Math.floor((jDayNo - 1) / 365);
    jDayNo = (jDayNo - 1) % 365;
  }

  let jm = 0;
  while (jm < 11 && jDayNo >= jDaysInMonth[jm]) {
    jDayNo -= jDaysInMonth[jm];
    jm++;
  }

  return [jy, jm + 1, jDayNo + 1];
}

function jalaliMonthLength(year: number, month: number): number {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  const nextYearDate = jalaliToGregorian(year + 1, 1, 1);
  const [gy, gm, gd] = nextYearDate.split("-").map(Number);
  const d = new Date(Date.UTC(gy, gm - 1, gd));
  d.setUTCDate(d.getUTCDate() - 1);
  const [jy, , jd] = gregorianToJalali(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
  );
  return jy === year ? jd : 29;
}

function calendarKeyboard(year: number, month: number): Keyboard {
  const monthNames = [
    "Farvardin","Ordibehesht","Khordad","Tir","Mordad","Shahrivar",
    "Mehr","Aban","Azar","Dey","Bahman","Esfand",
  ];

  const days: Keyboard = [[
    { text: "◀️", callback_data: `route:cal:${month === 1 ? year - 1 : year}:${month === 1 ? 12 : month - 1}` },
    { text: `${monthNames[month - 1]} ${year}`, callback_data: "noop" },
    { text: "▶️", callback_data: `route:cal:${month === 12 ? year + 1 : year}:${month === 12 ? 1 : month + 1}` },
  ]];

  days.push([
    { text: "ش", callback_data: "noop" },
    { text: "ی", callback_data: "noop" },
    { text: "د", callback_data: "noop" },
    { text: "س", callback_data: "noop" },
    { text: "چ", callback_data: "noop" },
    { text: "پ", callback_data: "noop" },
    { text: "ج", callback_data: "noop" },
  ]);

  const firstGregorian = jalaliToGregorian(year, month, 1).split("-").map(Number);
  const first = new Date(Date.UTC(firstGregorian[0], firstGregorian[1] - 1, firstGregorian[2]));
  const weekday = (first.getUTCDay() + 1) % 7; // Saturday=0

  let row: Array<{ text: string; callback_data: string }> = [];
  for (let i = 0; i < weekday; i++) row.push({ text: " ", callback_data: "noop" });

  const length = jalaliMonthLength(year, month);
  for (let day = 1; day <= length; day++) {
    const gregorian = jalaliToGregorian(year, month, day);
    row.push({
      text: String(day),
      callback_data: `route:date:${gregorian}:${year}:${month}:${day}`,
    });

    if (row.length === 7) {
      days.push(row);
      row = [];
    }
  }
  if (row.length) {
    while (row.length < 7) row.push({ text: " ", callback_data: "noop" });
    days.push(row);
  }

  days.push([{ text: "❌ Cancel", callback_data: "route:cancel" }]);
  return days;
}

async function showOriginSettings(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, name, name_fa, iata_code, is_active FROM origins ORDER BY name",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of rows.results ?? []) {
    const status = r.is_active ? "🟢" : "⚪";
    keyboard.push([
      { text: `${status} ${r.name} (${r.iata_code})`, callback_data: `origin:toggle:${r.id}` },
      { text: "🗑", callback_data: `origin:delete:${r.id}` },
    ]);
  }

  keyboard.push([{ text: "➕ Add Origin", callback_data: "origin:add" }]);
  keyboard.push([{ text: "⬅️ Settings", callback_data: "menu:settings" }]);

  await renderUi(
    env,
    userId,
    chatId,
    "🛫 Origins\n\n🟢 = active\n⚪ = inactive\n\nTap the name to enable/disable or 🗑 to delete:",
    keyboard,
  );
}

async function showDestinationSettings(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, name, name_fa, iata_code, is_active FROM destinations ORDER BY name",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of rows.results ?? []) {
    const status = r.is_active ? "🟢" : "⚪";
    keyboard.push([
      { text: `${status} ${r.name} (${r.iata_code})`, callback_data: `destination:toggle:${r.id}` },
      { text: "🗑", callback_data: `destination:delete:${r.id}` },
    ]);
  }

  keyboard.push([{ text: "➕ Add Destination", callback_data: "destination:add" }]);
  keyboard.push([{ text: "⬅️ Settings", callback_data: "menu:settings" }]);

  await renderUi(
    env,
    userId,
    chatId,
    "🛬 Destinations\n\n🟢 = active\n⚪ = inactive\n\nTap the name to enable/disable or 🗑 to delete:",
    keyboard,
  );
}

async function showWebsiteSettings(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, name, url, scraper_key, is_active FROM websites ORDER BY name",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of rows.results ?? []) {
    const status = r.is_active ? "🟢" : "⚪";
    keyboard.push([
      { text: `${status} ${r.name}`, callback_data: `website:toggle:${r.id}` },
    ]);
  }

  keyboard.push([{ text: "➕ Add Website", callback_data: "website:add" }]);
  keyboard.push([{ text: "⬅️ Settings", callback_data: "menu:settings" }]);

  await renderUi(env, userId, chatId, "🌐 Ticket Websites", keyboard);
}

async function showIntervalSettings(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, name, minutes, is_active FROM check_intervals ORDER BY minutes",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of rows.results ?? []) {
    const status = r.is_active ? "🟢" : "⚪";
    keyboard.push([
      { text: `${status} ${r.name} (${r.minutes} min)`, callback_data: `interval:toggle:${r.id}` },
    ]);
  }

  keyboard.push([{ text: "➕ Add Interval", callback_data: "interval:add" }]);
  keyboard.push([{ text: "⬅️ Settings", callback_data: "menu:settings" }]);

  await renderUi(env, userId, chatId, "⏱ Check Intervals", keyboard);
}

async function showAddOriginPrompt(env: Env, userId: number, chatId: number): Promise<void> {
  await setConversationState(env, userId, "origin_add_name");
  await renderUi(env, userId, chatId, "🛫 Add Origin\n\nStep 1/3\n\nEnter the airport/city name:", [
    [{ text: "❌ Cancel", callback_data: "input:cancel" }],
  ]);
}

async function showAddDestinationPrompt(env: Env, userId: number, chatId: number): Promise<void> {
  await setConversationState(env, userId, "destination_add_name");
  await renderUi(env, userId, chatId, "🛬 Add Destination\n\nStep 1/3\n\nEnter the airport/city name:", [
    [{ text: "❌ Cancel", callback_data: "input:cancel" }],
  ]);
}

async function showAddWebsitePrompt(env: Env, userId: number, chatId: number): Promise<void> {
  await setConversationState(env, userId, "website_add_name");
  await renderUi(env, userId, chatId, "🌐 Add Ticket Website\n\nStep 1/3\n\nEnter the website name:", [
    [{ text: "❌ Cancel", callback_data: "input:cancel" }],
  ]);
}

async function showAddIntervalPrompt(env: Env, userId: number, chatId: number): Promise<void> {
  await setConversationState(env, userId, "interval_add_name");
  await renderUi(env, userId, chatId, "⏱ Add Check Interval\n\nStep 1/2\n\nEnter a name, for example:\nEvery 30 minutes", [
    [{ text: "❌ Cancel", callback_data: "input:cancel" }],
  ]);
}

async function showAddRoute(env: Env, userId: number, chatId: number): Promise<void> {
  const origins = await env.DB.prepare(
    "SELECT id, name, iata_code FROM origins WHERE is_active=1 ORDER BY name",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of origins.results ?? []) {
    keyboard.push([{ text: `${r.name} (${r.iata_code})`, callback_data: `route:origin:${r.id}` }]);
  }
  keyboard.push([{ text: "❌ Cancel", callback_data: "route:cancel" }]);

  await setConversationState(env, userId, "route_origin", {});
  await renderUi(env, userId, chatId, "✈️ Add Route\n\nStep 1/5\n\nChoose departure airport:", keyboard);
}

async function showRouteDestination(
  env: Env,
  userId: number,
  chatId: number,
  originId: number,
): Promise<void> {
  const destinations = await env.DB.prepare(
    "SELECT id, name, iata_code FROM destinations WHERE is_active=1 ORDER BY name",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of destinations.results ?? []) {
    keyboard.push([{ text: `${r.name} (${r.iata_code})`, callback_data: `route:destination:${r.id}` }]);
  }
  keyboard.push([{ text: "❌ Cancel", callback_data: "route:cancel" }]);

  await setConversationState(env, userId, "route_destination", { origin_id: originId });
  await renderUi(env, userId, chatId, "✈️ Add Route\n\nStep 2/5\n\nChoose destination:", keyboard);
}

async function showRouteDate(
  env: Env,
  userId: number,
  chatId: number,
  originId: number,
  destinationId: number,
  year?: number,
  month?: number,
): Promise<void> {
  const now = new Date();
  const [jy, jm] = gregorianToJalali(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const y = year ?? jy;
  const m = month ?? jm;

  await setConversationState(env, userId, "route_date", {
    origin_id: originId,
    destination_id: destinationId,
    calendar_year: y,
    calendar_month: m,
  });

  await renderUi(
    env,
    userId,
    chatId,
    "✈️ Add Route\n\nStep 3/5\n\nChoose flight date (Jalali calendar):",
    calendarKeyboard(y, m),
  );
}

async function showRouteWebsites(
  env: Env,
  userId: number,
  chatId: number,
  stateData: Record<string, any>,
): Promise<void> {
  const websites = await env.DB.prepare(
    "SELECT id, name FROM websites WHERE is_active=1 ORDER BY name",
  ).all<any>();

  const selected: number[] = stateData.website_ids ?? [];
  const keyboard: Keyboard = [];

  for (const r of websites.results ?? []) {
    keyboard.push([{
      text: `${selected.includes(r.id) ? "✅" : "⬜"} ${r.name}`,
      callback_data: `route:website:${r.id}`,
    }]);
  }

  keyboard.push([{ text: "✅ Done", callback_data: "route:websites:done" }]);
  keyboard.push([{ text: "❌ Cancel", callback_data: "route:cancel" }]);

  await renderUi(env, userId, chatId, "✈️ Add Route\n\nStep 4/5\n\nSelect ticket websites.\nYou can select more than one:", keyboard);
}

async function showRouteInterval(
  env: Env,
  userId: number,
  chatId: number,
  stateData: Record<string, any>,
): Promise<void> {
  const intervals = await env.DB.prepare(
    "SELECT id, name, minutes FROM check_intervals WHERE is_active=1 ORDER BY minutes",
  ).all<any>();

  const keyboard: Keyboard = [];
  for (const r of intervals.results ?? []) {
    keyboard.push([{ text: `${r.name} (${r.minutes} min)`, callback_data: `route:interval:${r.id}` }]);
  }
  keyboard.push([{ text: "❌ Cancel", callback_data: "route:cancel" }]);

  await setConversationState(env, userId, "route_interval", stateData);
  await renderUi(env, userId, chatId, "✈️ Add Route\n\nStep 5/5\n\nChoose how often this route should be checked:", keyboard);
}

async function finishAddRoute(
  env: Env,
  userId: number,
  chatId: number,
  stateData: Record<string, any>,
  intervalId: number,
): Promise<void> {
  const route = await env.DB.prepare(`
    INSERT INTO routes
      (user_id, origin_id, destination_id, flight_date, flight_date_jalali,
       check_interval_id, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    RETURNING id
  `).bind(
    userId,
    stateData.origin_id,
    stateData.destination_id,
    stateData.flight_date,
    stateData.flight_date_jalali,
    intervalId,
  ).first<{ id: number }>();

  if (!route) throw new Error("Could not create route");

  for (const websiteId of stateData.website_ids ?? []) {
    await env.DB.prepare(
      "INSERT INTO route_websites (route_id, website_id) VALUES (?, ?)",
    ).bind(route.id, websiteId).run();
  }

  await clearConversationState(env, userId);
  await renderUi(
    env,
    userId,
    chatId,
    `✅ Route added successfully.\n\n${stateData.origin_iata} → ${stateData.destination_iata}\nDate: ${stateData.flight_date_jalali}\nWebsites: ${(stateData.website_ids ?? []).length}\nCheck interval: ${intervalId}`,
    [
      [{ text: "🔍 Check Now", callback_data: `route:check:${route.id}` }],
      [{ text: "📋 My Routes", callback_data: "menu:routes" }],
      [{ text: "⬅️ Main Menu", callback_data: "menu:main" }],
    ],
  );
}

async function showRoutes(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.flight_date,
      r.flight_date_jalali,
      r.is_active,
      o.name AS origin_name,
      o.iata_code AS origin_iata,
      d.name AS destination_name,
      d.iata_code AS destination_iata
    FROM routes r
    JOIN origins o ON o.id = r.origin_id
    JOIN destinations d ON d.id = r.destination_id
    WHERE r.user_id = ?
    ORDER BY r.flight_date
  `).bind(userId).all<any>();

  const keyboard: Keyboard = [];
  for (const r of rows.results ?? []) {
    keyboard.push([{
      text: `${r.is_active ? "🟢" : "⚪"} ${r.origin_iata} → ${r.destination_iata} | ${r.flight_date_jalali ?? r.flight_date}`,
      callback_data: `route:view:${r.id}`,
    }]);
  }

  keyboard.push([{ text: "➕ Add Route", callback_data: "menu:add_route" }]);
  keyboard.push([{ text: "⬅️ Main Menu", callback_data: "menu:main" }]);

  await renderUi(
    env,
    userId,
    chatId,
    rows.results?.length
      ? "📋 My Routes\n\nSelect a route:"
      : "📋 My Routes\n\nYou don't have any routes yet.",
    keyboard,
  );
}

async function showRouteDetails(env: Env, userId: number, chatId: number, routeId: number): Promise<void> {
  const r = await env.DB.prepare(`
    SELECT
      r.*,
      o.name AS origin_name, o.iata_code AS origin_iata,
      d.name AS destination_name, d.iata_code AS destination_iata,
      ci.name AS interval_name, ci.minutes
    FROM routes r
    JOIN origins o ON o.id = r.origin_id
    JOIN destinations d ON d.id = r.destination_id
    LEFT JOIN check_intervals ci ON ci.id = r.check_interval_id
    WHERE r.id = ? AND r.user_id = ?
  `).bind(routeId, userId).first<any>();

  if (!r) {
    await showRoutes(env, userId, chatId);
    return;
  }

  const websites = await env.DB.prepare(`
    SELECT w.name
    FROM route_websites rw
    JOIN websites w ON w.id = rw.website_id
    WHERE rw.route_id = ?
    ORDER BY w.name
  `).bind(routeId).all<any>();

  const names = (websites.results ?? []).map((x: any) => x.name).join(", ") || "None";

  await renderUi(
    env,
    userId,
    chatId,
    `✈️ Route #${routeId}\n\n` +
    `${r.origin_name} (${r.origin_iata}) → ${r.destination_name} (${r.destination_iata})\n` +
    `Date: ${r.flight_date_jalali ?? r.flight_date}\n` +
    `Websites: ${names}\n` +
    `Interval: ${r.interval_name ?? "Not set"}\n` +
    `Status: ${r.is_active ? "🟢 Active" : "⚪ Inactive"}\n` +
    `Last check: ${r.last_checked_at ?? "Never"}\n` +
    `Next check: ${r.next_check_at ?? "Not scheduled"}`,
    [
      [{ text: r.is_active ? "⏸ Disable" : "▶️ Enable", callback_data: `route:toggle:${routeId}` }],
      [{ text: "🔍 Check Now", callback_data: `route:check:${routeId}` }],
      [{ text: "⬅️ My Routes", callback_data: "menu:routes" }],
    ],
  );
}

async function queueRouteCheck(
  env: Env,
  userId: number,
  chatId: number,
  routeId: number,
): Promise<void> {
  const route = await env.DB.prepare(`
    SELECT r.id, r.flight_date, ci.minutes
    FROM routes r
    LEFT JOIN check_intervals ci ON ci.id = r.check_interval_id
    WHERE r.id = ? AND r.user_id = ?
  `).bind(routeId, userId).first<any>();

  if (!route) {
    await renderUi(env, userId, chatId, "❌ Route not found.", [
      [{ text: "⬅️ My Routes", callback_data: "menu:routes" }],
    ]);
    return;
  }

  const websites = await env.DB.prepare(`
    SELECT website_id
    FROM route_websites
    WHERE route_id = ?
  `).bind(routeId).all<any>();

  let created = 0;
  for (const w of websites.results ?? []) {
    await env.DB.prepare(`
      INSERT INTO scraping_jobs
        (route_id, website_id, status, created_at)
      VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
    `).bind(routeId, w.website_id).run();
    created++;
  }

  const minutes = Number(route.minutes ?? 60);
  await env.DB.prepare(`
    UPDATE routes
    SET last_checked_at = CURRENT_TIMESTAMP,
        next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes')
    WHERE id = ?
  `).bind(minutes, routeId).run();

  await renderUi(
    env,
    userId,
    chatId,
    `🔍 Check requested.\n\n${created} scraping job(s) queued.\n\nThe actual scraper will process these jobs through the GitHub Actions scraping layer.`,
    [
      [{ text: "📋 View Route", callback_data: `route:view:${routeId}` }],
      [{ text: "📊 Results", callback_data: "menu:results" }],
      [{ text: "⬅️ Main Menu", callback_data: "menu:main" }],
    ],
  );
}

async function showResults(env: Env, userId: number, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT
      fr.id,
      fr.available,
      fr.price,
      fr.currency,
      fr.flight_number,
      fr.departure_time,
      fr.arrival_time,
      fr.checked_at,
      o.iata_code AS origin_iata,
      d.iata_code AS destination_iata,
      w.name AS website_name
    FROM flight_results fr
    JOIN routes r ON r.id = fr.route_id
    JOIN origins o ON o.id = r.origin_id
    JOIN destinations d ON d.id = r.destination_id
    JOIN websites w ON w.id = fr.website_id
    WHERE r.user_id = ?
    ORDER BY fr.checked_at DESC
    LIMIT 20
  `).bind(userId).all<any>();

  let text = "📊 Latest Results\n\n";

  if (!(rows.results ?? []).length) {
    text += "No flight results have been recorded yet.";
  } else {
    for (const r of rows.results ?? []) {
      text +=
        `${r.available ? "🟢" : "🔴"} ${r.origin_iata} → ${r.destination_iata}\n` +
        `🌐 ${r.website_name}\n` +
        `💰 ${r.available && r.price != null ? `${r.price} ${r.currency ?? ""}` : "Unavailable"}\n` +
        `${r.flight_number ? `✈️ ${r.flight_number}\n` : ""}` +
        `${r.checked_at ?? ""}\n\n`;
    }
  }

  await renderUi(env, userId, chatId, text, [
    [{ text: "🔄 Refresh", callback_data: "menu:results" }],
    [{ text: "⬅️ Main Menu", callback_data: "menu:main" }],
  ]);
}

async function showNotifications(env: Env, userId: number, chatId: number): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT us.notifications_enabled
    FROM user_settings us
    JOIN users u ON u.id = us.user_id
    WHERE u.telegram_user_id = ?
  `).bind(userId).first<any>();

  await renderUi(
    env,
    userId,
    chatId,
    `🔔 Notifications\n\nStatus: ${row?.notifications_enabled ? "🟢 Enabled" : "⚪ Disabled"}`,
    [
      [{ text: row?.notifications_enabled ? "🔕 Disable" : "🔔 Enable", callback_data: "settings:notifications:toggle" }],
      [{ text: "⬅️ Settings", callback_data: "menu:settings" }],
    ],
  );
}

async function showLanguage(env: Env, userId: number, chatId: number): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT us.language
    FROM user_settings us
    JOIN users u ON u.id = us.user_id
    WHERE u.telegram_user_id = ?
  `).bind(userId).first<any>();

  await renderUi(env, userId, chatId, `🌍 Language\n\nCurrent: ${row?.language ?? "en"}`, [
    [{ text: "🇬🇧 English", callback_data: "language:set:en" }],
    [{ text: "🇮🇷 فارسی", callback_data: "language:set:fa" }],
    [{ text: "⬅️ Settings", callback_data: "menu:settings" }],
  ]);
}

async function deleteOrigin(env: Env, userId: number, chatId: number, id: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id, name, iata_code FROM origins WHERE id = ?",
  ).bind(id).first<any>();

  if (!row) {
    await showOriginSettings(env, userId, chatId);
    return;
  }

  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM routes WHERE origin_id = ?",
  ).bind(id).first<any>();

  if (Number(used?.count ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE origins SET is_active = 0 WHERE id = ?",
    ).bind(id).run();

    await renderUi(
      env, userId, chatId,
      `⚠️ ${row.name} (${row.iata_code}) is already used by a route, so it cannot be physically deleted without breaking that route.\n\nIt has been disabled instead and will no longer appear when creating new routes.`,
      [
        [{ text: "🛫 Back to Origins", callback_data: "settings:origins" }],
        [{ text: "⚙️ Settings", callback_data: "menu:settings" }],
      ],
    );
    return;
  }

  await env.DB.prepare("DELETE FROM origins WHERE id = ?").bind(id).run();

  await renderUi(
    env, userId, chatId,
    `🗑 Origin deleted:\n${row.name} (${row.iata_code})`,
    [[{ text: "🛫 Back to Origins", callback_data: "settings:origins" }]],
  );
}

async function deleteDestination(env: Env, userId: number, chatId: number, id: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id, name, iata_code FROM destinations WHERE id = ?",
  ).bind(id).first<any>();

  if (!row) {
    await showDestinationSettings(env, userId, chatId);
    return;
  }

  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM routes WHERE destination_id = ?",
  ).bind(id).first<any>();

  if (Number(used?.count ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE destinations SET is_active = 0 WHERE id = ?",
    ).bind(id).run();

    await renderUi(
      env, userId, chatId,
      `⚠️ ${row.name} (${row.iata_code}) is already used by a route, so it cannot be physically deleted without breaking that route.\n\nIt has been disabled instead and will no longer appear when creating new routes.`,
      [
        [{ text: "🛬 Back to Destinations", callback_data: "settings:destinations" }],
        [{ text: "⚙️ Settings", callback_data: "menu:settings" }],
      ],
    );
    return;
  }

  await env.DB.prepare("DELETE FROM destinations WHERE id = ?").bind(id).run();

  await renderUi(
    env, userId, chatId,
    `🗑 Destination deleted:\n${row.name} (${row.iata_code})`,
    [[{ text: "🛬 Back to Destinations", callback_data: "settings:destinations" }]],
  );
}

async function handleText(
  env: Env,
  message: TgMessage,
): Promise<void> {
  if (!message.from || !message.text) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();

  const current = await getConversationState(env, userId);
  if (!current) {
    await showMainMenu(env, userId, chatId);
    return;
  }

  const data = current.data;

  if (current.state === "origin_add_name") {
    await setConversationState(env, userId, "origin_add_fa", { name: text });
    await renderUi(env, userId, chatId, "🛫 Add Origin\n\nStep 2/3\n\nEnter Persian name (or type the same name):", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "origin_add_fa") {
    await setConversationState(env, userId, "origin_add_iata", {
      name: data.name,
      name_fa: text,
    });
    await renderUi(env, userId, chatId, "🛫 Add Origin\n\nStep 3/3\n\nEnter the 3-letter IATA code, for example LAX:", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "origin_add_iata") {
    const iata = text.toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) {
      await renderUi(env, userId, chatId, "❌ IATA code must contain exactly 3 English letters.\n\nPlease try again:", [
        [{ text: "❌ Cancel", callback_data: "input:cancel" }],
      ]);
      return;
    }

    await env.DB.prepare(`
      INSERT INTO origins (name, name_fa, iata_code, is_active)
      VALUES (?, ?, ?, 1)
    `).bind(data.name, data.name_fa, iata).run();

    await clearConversationState(env, userId);
    await showOriginSettings(env, userId, chatId);
    return;
  }

  if (current.state === "destination_add_name") {
    await setConversationState(env, userId, "destination_add_fa", { name: text });
    await renderUi(env, userId, chatId, "🛬 Add Destination\n\nStep 2/3\n\nEnter Persian name (or type the same name):", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "destination_add_fa") {
    await setConversationState(env, userId, "destination_add_iata", {
      name: data.name,
      name_fa: text,
    });
    await renderUi(env, userId, chatId, "🛬 Add Destination\n\nStep 3/3\n\nEnter the 3-letter IATA code, for example JFK:", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "destination_add_iata") {
    const iata = text.toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) {
      await renderUi(env, userId, chatId, "❌ IATA code must contain exactly 3 English letters.\n\nPlease try again:", [
        [{ text: "❌ Cancel", callback_data: "input:cancel" }],
      ]);
      return;
    }

    await env.DB.prepare(`
      INSERT INTO destinations (name, name_fa, iata_code, is_active)
      VALUES (?, ?, ?, 1)
    `).bind(data.name, data.name_fa, iata).run();

    await clearConversationState(env, userId);
    await showDestinationSettings(env, userId, chatId);
    return;
  }

  if (current.state === "website_add_name") {
    await setConversationState(env, userId, "website_add_url", { name: text });
    await renderUi(env, userId, chatId, "🌐 Add Ticket Website\n\nStep 2/3\n\nEnter the website URL:", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "website_add_url") {
    await setConversationState(env, userId, "website_add_key", {
      name: data.name,
      url: text,
    });
    await renderUi(env, userId, chatId, "🌐 Add Ticket Website\n\nStep 3/3\n\nEnter a scraper key, for example:\nexample_com", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "website_add_key") {
    await env.DB.prepare(`
      INSERT INTO websites (name, url, scraper_key, is_active)
      VALUES (?, ?, ?, 1)
    `).bind(data.name, data.url, text).run();

    await clearConversationState(env, userId);
    await showWebsiteSettings(env, userId, chatId);
    return;
  }

  if (current.state === "interval_add_name") {
    await setConversationState(env, userId, "interval_add_minutes", { name: text });
    await renderUi(env, userId, chatId, "⏱ Add Check Interval\n\nStep 2/2\n\nEnter the interval in minutes, for example 30:", [
      [{ text: "❌ Cancel", callback_data: "input:cancel" }],
    ]);
    return;
  }

  if (current.state === "interval_add_minutes") {
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      await renderUi(env, userId, chatId, "❌ Please enter a positive whole number of minutes:", [
        [{ text: "❌ Cancel", callback_data: "input:cancel" }],
      ]);
      return;
    }

    await env.DB.prepare(`
      INSERT INTO check_intervals (name, minutes, is_active)
      VALUES (?, ?, 1)
    `).bind(data.name, minutes).run();

    await clearConversationState(env, userId);
    await showIntervalSettings(env, userId, chatId);
    return;
  }

  await renderUi(env, userId, chatId, "Please use the buttons below.", MAIN_MENU);
}

async function handleButton(
  env: Env,
  callback: TgCallbackQuery,
): Promise<void> {
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id ?? userId;
  const data = callback.data ?? "";

  await answerCallbackQuery(env, callback.id);

  if (callback.message?.message_id) {
    await setUiMessageId(env, userId, callback.message.message_id);
  }

  if (data === "noop") return;

  if (data === "menu:main") {
    await showMainMenu(env, userId, chatId);
    return;
  }

  if (data === "menu:settings") {
    await clearConversationState(env, userId);
    await showSettings(env, userId, chatId);
    return;
  }

  if (data === "menu:add_route") {
    await showAddRoute(env, userId, chatId);
    return;
  }

  if (data === "route:cancel" || data === "input:cancel") {
    await clearConversationState(env, userId);
    await showMainMenu(env, userId, chatId);
    return;
  }

  if (data === "settings:origins") {
    await clearConversationState(env, userId);
    await showOriginSettings(env, userId, chatId);
    return;
  }

  if (data === "settings:destinations") {
    await clearConversationState(env, userId);
    await showDestinationSettings(env, userId, chatId);
    return;
  }

  if (data === "settings:websites") {
    await clearConversationState(env, userId);
    await showWebsiteSettings(env, userId, chatId);
    return;
  }

  if (data === "settings:intervals") {
    await clearConversationState(env, userId);
    await showIntervalSettings(env, userId, chatId);
    return;
  }

  if (data === "settings:notifications") {
    await showNotifications(env, userId, chatId);
    return;
  }

  if (data === "settings:notifications:toggle") {
    await env.DB.prepare(`
      UPDATE user_settings
      SET notifications_enabled =
        CASE WHEN notifications_enabled = 1 THEN 0 ELSE 1 END
      WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = ?)
    `).bind(userId).run();
    await showNotifications(env, userId, chatId);
    return;
  }

  if (data === "settings:language") {
    await showLanguage(env, userId, chatId);
    return;
  }

  if (data.startsWith("language:set:")) {
    const language = data.split(":")[2];
    if (language === "en" || language === "fa") {
      await env.DB.prepare(`
        UPDATE user_settings
        SET language = ?
        WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = ?)
      `).bind(language, userId).run();
    }
    await showLanguage(env, userId, chatId);
    return;
  }

  if (data === "origin:add") {
    await showAddOriginPrompt(env, userId, chatId);
    return;
  }

  if (data.startsWith("origin:toggle:")) {
    const id = Number(data.split(":")[2]);
    await env.DB.prepare(`
      UPDATE origins
      SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).bind(id).run();
    await showOriginSettings(env, userId, chatId);
    return;
  }

  if (data.startsWith("origin:delete:")) {
    const id = Number(data.split(":")[2]);
    await deleteOrigin(env, userId, chatId, id);
    return;
  }

  if (data === "destination:add") {
    await showAddDestinationPrompt(env, userId, chatId);
    return;
  }

  if (data.startsWith("destination:toggle:")) {
    const id = Number(data.split(":")[2]);
    await env.DB.prepare(`
      UPDATE destinations
      SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).bind(id).run();
    await showDestinationSettings(env, userId, chatId);
    return;
  }

  if (data.startsWith("destination:delete:")) {
    const id = Number(data.split(":")[2]);
    await deleteDestination(env, userId, chatId, id);
    return;
  }

  if (data === "website:add") {
    await showAddWebsitePrompt(env, userId, chatId);
    return;
  }

  if (data.startsWith("website:toggle:")) {
    const id = Number(data.split(":")[2]);
    await env.DB.prepare(`
      UPDATE websites
      SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).bind(id).run();
    await showWebsiteSettings(env, userId, chatId);
    return;
  }

  if (data === "interval:add") {
    await showAddIntervalPrompt(env, userId, chatId);
    return;
  }

  if (data.startsWith("interval:toggle:")) {
    const id = Number(data.split(":")[2]);
    await env.DB.prepare(`
      UPDATE check_intervals
      SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).bind(id).run();
    await showIntervalSettings(env, userId, chatId);
    return;
  }

  if (data.startsWith("route:origin:")) {
    const originId = Number(data.split(":")[2]);
    const origin = await env.DB.prepare(
      "SELECT id, name, iata_code FROM origins WHERE id = ? AND is_active=1",
    ).bind(originId).first<any>();

    if (!origin) {
      await showAddRoute(env, userId, chatId);
      return;
    }

    await showRouteDestination(env, userId, chatId, originId);
    const state = await getConversationState(env, userId);
    if (state) {
      state.data.origin_name = origin.name;
      state.data.origin_iata = origin.iata_code;
      await setConversationState(env, userId, state.state, state.data);
    }
    return;
  }

  if (data.startsWith("route:destination:")) {
    const destinationId = Number(data.split(":")[2]);
    const current = await getConversationState(env, userId);
    if (!current?.data.origin_id) {
      await showAddRoute(env, userId, chatId);
      return;
    }

    const destination = await env.DB.prepare(
      "SELECT id, name, iata_code FROM destinations WHERE id = ? AND is_active=1",
    ).bind(destinationId).first<any>();

    if (!destination) {
      await showAddRoute(env, userId, chatId);
      return;
    }

    await showRouteDate(
      env,
      userId,
      chatId,
      current.data.origin_id,
      destinationId,
    );

    const state = await getConversationState(env, userId);
    if (state) {
      state.data.destination_name = destination.name;
      state.data.destination_iata = destination.iata_code;
      await setConversationState(env, userId, state.state, state.data);
    }
    return;
  }

  if (data.startsWith("route:cal:")) {
    const parts = data.split(":");
    const year = Number(parts[2]);
    const month = Number(parts[3]);
    const current = await getConversationState(env, userId);

    if (!current?.data.origin_id || !current?.data.destination_id) {
      await showAddRoute(env, userId, chatId);
      return;
    }

    await showRouteDate(
      env,
      userId,
      chatId,
      current.data.origin_id,
      current.data.destination_id,
      year,
      month,
    );
    return;
  }

  if (data.startsWith("route:date:")) {
    const parts = data.split(":");
    const gregorian = parts[2];
    const jy = Number(parts[3]);
    const jm = Number(parts[4]);
    const jd = Number(parts[5]);

    const current = await getConversationState(env, userId);
    if (!current) return;

    const nextData = {
      ...current.data,
      flight_date: gregorian,
      flight_date_jalali: `${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`,
      website_ids: [],
    };

    await setConversationState(env, userId, "route_websites", nextData);
    await showRouteWebsites(env, userId, nextData);
    return;
  }

  if (data.startsWith("route:website:")) {
    const websiteId = Number(data.split(":")[2]);
    const current = await getConversationState(env, userId);
    if (!current) return;

    const selected: number[] = current.data.website_ids ?? [];
    const next = selected.includes(websiteId)
      ? selected.filter((x) => x !== websiteId)
      : [...selected, websiteId];

    const nextData = { ...current.data, website_ids: next };
    await setConversationState(env, userId, "route_websites", nextData);
    await showRouteWebsites(env, userId, nextData);
    return;
  }

  if (data === "route:websites:done") {
    const current = await getConversationState(env, userId);
    if (!current || !(current.data.website_ids ?? []).length) {
      await renderUi(env, userId, chatId, "❌ Please select at least one ticket website.", [
        [{ text: "⬅️ Back", callback_data: "menu:add_route" }],
      ]);
      return;
    }

    await showRouteInterval(env, userId, chatId, current.data);
    return;
  }

  if (data.startsWith("route:interval:")) {
    const intervalId = Number(data.split(":")[2]);
    const current = await getConversationState(env, userId);
    if (!current) return;

    await finishAddRoute(env, userId, chatId, current.data, intervalId);
    return;
  }

  if (data === "menu:routes") {
    await clearConversationState(env, userId);
    await showRoutes(env, userId, chatId);
    return;
  }

  if (data.startsWith("route:view:")) {
    await showRouteDetails(env, userId, chatId, Number(data.split(":")[2]));
    return;
  }

  if (data.startsWith("route:toggle:")) {
    const routeId = Number(data.split(":")[2]);
    await env.DB.prepare(`
      UPDATE routes
      SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
      WHERE id = ? AND user_id = ?
    `).bind(routeId, userId).run();
    await showRouteDetails(env, userId, chatId, routeId);
    return;
  }

  if (data.startsWith("route:check:")) {
    await queueRouteCheck(env, userId, chatId, Number(data.split(":")[2]));
    return;
  }

  if (data === "menu:check") {
    const rows = await env.DB.prepare(`
      SELECT r.id, o.iata_code origin_iata, d.iata_code destination_iata, r.flight_date_jalali
      FROM routes r
      JOIN origins o ON o.id = r.origin_id
      JOIN destinations d ON d.id = r.destination_id
      WHERE r.user_id = ? AND r.is_active = 1
      ORDER BY r.flight_date
    `).bind(userId).all<any>();

    const keyboard: Keyboard = [];
    for (const r of rows.results ?? []) {
      keyboard.push([{
        text: `${r.origin_iata} → ${r.destination_iata} | ${r.flight_date_jalali ?? ""}`,
        callback_data: `route:check:${r.id}`,
      }]);
    }
    keyboard.push([{ text: "⬅️ Main Menu", callback_data: "menu:main" }]);

    await renderUi(env, userId, chatId, "🔍 Check Now\n\nChoose a route to check:", keyboard);
    return;
  }

  if (data === "menu:results") {
    await showResults(env, userId, chatId);
    return;
  }

  await renderUi(env, userId, chatId, "Unknown button. Returning to the main menu.", MAIN_MENU);
}

async function handleUpdate(env: Env, update: any): Promise<void> {
  if (update.message) {
    const message = update.message as TgMessage;
    if (message.from) {
      await registerUser(env, message.from);
    }

    if (message.text === "/start") {
      await showMainMenu(env, message.from!.id, message.chat.id);
    } else {
      await handleText(env, message);
    }
    return;
  }

  if (update.callback_query) {
    const callback = update.callback_query as TgCallbackQuery;
    await registerUser(env, callback.from);
    await handleButton(env, callback);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Flight Tracker Bot is running.", { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "flight-tracker-bot" });
    }

    if (request.method === "GET" && url.pathname === "/setup-webhook") {
      const key = url.searchParams.get("key");
      if (!key || key !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const webhookUrl = `${url.origin}/telegram/webhook`;

      const result = await telegramApi(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });

      return Response.json({ ok: true, telegram: result });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();
        await handleUpdate(env, update);
        return new Response("OK");
      } catch (error) {
        console.error("Webhook error:", error);
        return new Response("OK");
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
