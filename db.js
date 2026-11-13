import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, "data");
fs.mkdirSync(dataDir, { recursive: true });
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, "dces.db");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'encoder')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, ?)
  `);
  if (process.env.NODE_ENV === "production") {
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || "";
    if (initialPassword.length < 12) {
      throw new Error("For public demo deployment, set INITIAL_ADMIN_PASSWORD to a unique password of at least 12 characters in Render.");
    }
    const username = process.env.INITIAL_ADMIN_USERNAME || "admin";
    insert.run(username, "System Administrator", bcrypt.hashSync(initialPassword, 12), "admin");
    console.log("Initial production demo administrator created. Change credentials after first login.");
  } else {
    insert.run("admin", "System Administrator", bcrypt.hashSync("admin123", 12), "admin");
    insert.run("user", "Encoder User", bcrypt.hashSync("user123", 12), "encoder");
    console.log("Initial local accounts created: admin and user.");
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS reporting_years (
    year INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO reporting_years(year,status) VALUES (2027,'active');
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_id INTEGER NOT NULL DEFAULT 2027 REFERENCES reporting_years(year),
    activity_id TEXT NOT NULL UNIQUE,
    scope TEXT, program_classification TEXT, gad_mandate TEXT,
    gender_issue TEXT, cause_gender_issue TEXT, gad_activity TEXT NOT NULL,
    objectives TEXT, performance_indicators TEXT,
    targets_female TEXT, targets_male TEXT, targets_na TEXT,
    budget_nep REAL DEFAULT 0, nep_cost_breakdown TEXT, nep_justification TEXT,
    gaa_female TEXT, gaa_male TEXT, gaa_na TEXT, budget_gaa REAL DEFAULT 0,
    gaa_cost_breakdown TEXT, gaa_justification TEXT, variance_remarks TEXT,
    actual_female TEXT, actual_male TEXT, actual_na TEXT, actual_results TEXT,
    status TEXT DEFAULT 'Not Started', actual_cost REAL DEFAULT 0,
    actual_cost_breakdown TEXT, actual_justification TEXT, actual_variance TEXT,
    budget_source TEXT, responsible_unit TEXT,
    created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS budget_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL,
    category TEXT NOT NULL,
    item TEXT,
    position TEXT,
    staff_count REAL DEFAULT 0,
    hours REAL DEFAULT 0,
    patients REAL DEFAULT 0,
    salary_grade TEXT,
    hourly_rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    notes TEXT,
    FOREIGN KEY(activity_id) REFERENCES activities(activity_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS utilization (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL,
    month INTEGER NOT NULL,
    category TEXT NOT NULL,
    item TEXT,
    position TEXT,
    staff_count REAL DEFAULT 0,
    hours REAL DEFAULT 0,
    patients REAL DEFAULT 0,
    salary_grade TEXT,
    hourly_rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(activity_id) REFERENCES activities(activity_id) ON DELETE CASCADE
  );
`);


const activityColumns = db.prepare("PRAGMA table_info(activities)").all().map(c => c.name);
if (!activityColumns.includes("year_id")) {
  db.exec("ALTER TABLE activities ADD COLUMN year_id INTEGER NOT NULL DEFAULT 2027");
}


// Salary schedule imported from the supplied GPB Consolidated workbook.
// The source workbook's active salary schedule is 2026; do not label it as 2027.
db.exec(`
  CREATE TABLE IF NOT EXISTS salary_rates (
    effective_year INTEGER NOT NULL,
    position TEXT NOT NULL,
    salary_grade INTEGER NOT NULL,
    basic_salary REAL NOT NULL,
    annual_total REAL NOT NULL,
    monthly_total REAL NOT NULL,
    daily_rate REAL NOT NULL,
    halfday_rate REAL NOT NULL,
    hourly_rate REAL NOT NULL,
    PRIMARY KEY (effective_year, position)
  );
`);
const salaryRateCount = db.prepare("SELECT COUNT(*) AS count FROM salary_rates WHERE effective_year=2026").get().count;
if (salaryRateCount === 0) {
  const rates = JSON.parse(fs.readFileSync(path.join(here, "salary-rates-2026.json"), "utf8"));
  const insertRate = db.prepare(`INSERT OR IGNORE INTO salary_rates
    (effective_year,position,salary_grade,basic_salary,annual_total,monthly_total,daily_rate,halfday_rate,hourly_rate)
    VALUES (@effective_year,@position,@salary_grade,@basic_salary,@annual_total,@monthly_total,@daily_rate,@halfday_rate,@hourly_rate)`);
  const seedRates = db.transaction(items => items.forEach(item => insertRate.run(item)));
  seedRates(rates);
}
