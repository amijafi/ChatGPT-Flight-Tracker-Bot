-- ============================================================
-- Flight Tracker Bot
-- Migration 0001
--
-- Initial database structure
--
-- IMPORTANT:
-- Do not manually modify these tables in the Cloudflare
-- dashboard. Future database changes will be added through
-- new migration files.
-- ============================================================


-- ============================================================
-- USERS
-- ============================================================
-- One record for every Telegram user who interacts with the bot.

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    telegram_user_id INTEGER NOT NULL UNIQUE,

    username TEXT,
    first_name TEXT,
    last_name TEXT,

    language_code TEXT,

    is_active INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- ORIGINS
-- ============================================================
-- Airports/cities that can be selected as departure points.
--
-- These are configured through the bot's Settings menu.
-- Users don't need to type them when creating a route.

CREATE TABLE origins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL,
    name_fa TEXT,

    airport_code TEXT,

    is_active INTEGER NOT NULL DEFAULT 1,

    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- DESTINATIONS
-- ============================================================
-- Airports/cities that can be selected as destinations.

CREATE TABLE destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL,
    name_fa TEXT,

    airport_code TEXT,

    is_active INTEGER NOT NULL DEFAULT 1,

    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- TICKET WEBSITES
-- ============================================================
-- Websites that can be used by the scraper system.
--
-- The actual scraper implementation will live in GitHub.
-- D1 only stores the configuration and identity of each site.

CREATE TABLE websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL UNIQUE,

    base_url TEXT,

    scraper_key TEXT NOT NULL UNIQUE,

    is_active INTEGER NOT NULL DEFAULT 1,

    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- CHECK INTERVALS
-- ============================================================
-- Predefined intervals shown to users as buttons.
--
-- Example:
-- 5 minutes
-- 15 minutes
-- 30 minutes
-- 1 hour
-- 3 hours
-- 6 hours
-- 12 hours

CREATE TABLE check_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name TEXT NOT NULL,
    minutes INTEGER NOT NULL UNIQUE,

    is_active INTEGER NOT NULL DEFAULT 1,

    sort_order INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- ROUTES
-- ============================================================
-- A route requested by a Telegram user.
--
-- Example:
--
-- User:
--     Amin
--
-- Origin:
--     IKA
--
-- Destination:
--     ARN
--
-- Flight date:
--     2026-10-07
--
-- Check interval:
--     30 minutes

CREATE TABLE routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id INTEGER NOT NULL,

    origin_id INTEGER NOT NULL,
    destination_id INTEGER NOT NULL,

    -- Gregorian date used internally.
    --
    -- The user interface will use the Shamsi/Jalali calendar.
    flight_date TEXT NOT NULL,

    -- Original Jalali date selected by the user.
    --
    -- Keeping this allows us to display exactly what the
    -- user selected without having to convert it again.
    jalali_date TEXT NOT NULL,

    check_interval_id INTEGER NOT NULL,

    is_active INTEGER NOT NULL DEFAULT 1,

    last_checked_at TEXT,
    next_check_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (origin_id)
        REFERENCES origins(id),

    FOREIGN KEY (destination_id)
        REFERENCES destinations(id),

    FOREIGN KEY (check_interval_id)
        REFERENCES check_intervals(id)
);


-- ============================================================
-- ROUTE WEBSITES
-- ============================================================
-- Many-to-many relationship between routes and ticket sites.
--
-- A route can use multiple websites.
--
-- Example:
--
-- Tehran → Stockholm
--     ├── Site A
--     ├── Site B
--     └── Site C

CREATE TABLE route_websites (
    route_id INTEGER NOT NULL,
    website_id INTEGER NOT NULL,

    PRIMARY KEY (route_id, website_id),

    FOREIGN KEY (route_id)
        REFERENCES routes(id)
        ON DELETE CASCADE,

    FOREIGN KEY (website_id)
        REFERENCES websites(id)
        ON DELETE CASCADE
);


-- ============================================================
-- SCRAPING JOBS
-- ============================================================
-- Every actual scraping request gets a job record.
--
-- This lets us track:
--
-- pending
-- running
-- completed
-- failed

CREATE TABLE scraping_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    route_id INTEGER NOT NULL,
    website_id INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    started_at TEXT,
    completed_at TEXT,

    error_message TEXT,

    attempt_count INTEGER NOT NULL DEFAULT 0,

    FOREIGN KEY (route_id)
        REFERENCES routes(id)
        ON DELETE CASCADE,

    FOREIGN KEY (website_id)
        REFERENCES websites(id)
        ON DELETE CASCADE
);


-- ============================================================
-- FLIGHT RESULTS
-- ============================================================
-- Represents a flight found by a scraper.

CREATE TABLE flight_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    route_id INTEGER NOT NULL,
    website_id INTEGER NOT NULL,

    scraping_job_id INTEGER,

    flight_identifier TEXT,

    airline TEXT,

    flight_number TEXT,

    departure_time TEXT,
    arrival_time TEXT,

    duration_minutes INTEGER,

    stops INTEGER,

    available_seats INTEGER,

    cabin_class TEXT,

    currency TEXT,

    price REAL,

    booking_url TEXT,

    scraped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (route_id)
        REFERENCES routes(id)
        ON DELETE CASCADE,

    FOREIGN KEY (website_id)
        REFERENCES websites(id)
        ON DELETE CASCADE,

    FOREIGN KEY (scraping_job_id)
        REFERENCES scraping_jobs(id)
        ON DELETE SET NULL
);


-- ============================================================
-- PRICE HISTORY
-- ============================================================
-- Stores historical prices so we can detect changes.
--
-- Example:
--
-- 10:00 → 48,500,000
-- 10:30 → 48,500,000
-- 11:00 → 45,900,000
--
-- The bot can then detect the price decrease.

CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    flight_result_id INTEGER NOT NULL,

    price REAL NOT NULL,
    currency TEXT NOT NULL,

    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (flight_result_id)
        REFERENCES flight_results(id)
        ON DELETE CASCADE
);


-- ============================================================
-- USER SETTINGS
-- ============================================================
-- General per-user preferences.
--
-- We deliberately keep this small for now.
-- Additional settings can be added through later migrations.

CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY,

    notifications_enabled INTEGER NOT NULL DEFAULT 1,

    language TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_routes_user_id
    ON routes(user_id);

CREATE INDEX idx_routes_next_check
    ON routes(next_check_at);

CREATE INDEX idx_routes_active
    ON routes(is_active);

CREATE INDEX idx_scraping_jobs_status
    ON scraping_jobs(status);

CREATE INDEX idx_scraping_jobs_route
    ON scraping_jobs(route_id);

CREATE INDEX idx_flight_results_route
    ON flight_results(route_id);

CREATE INDEX idx_flight_results_scraped_at
    ON flight_results(scraped_at);

CREATE INDEX idx_price_history_flight
    ON price_history(flight_result_id);

CREATE INDEX idx_price_history_recorded_at
    ON price_history(recorded_at);
