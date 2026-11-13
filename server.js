import express from "express";
import cors from "cors";
import session from "express-session";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? "" : "local-development-only-change-before-deploy");
if (isProduction && sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be configured in production and contain at least 32 characters.");
}

app.set("trust proxy", 1);
app.use((_req, res, next) => {
  if (isProduction) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.use(cors({ origin: process.env.APP_ORIGIN || "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "dces.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please log in." });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.user?.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "DCES Demo API", storage: "ephemeral-sqlite", demoOnly: true }));


app.get("/api/salary-rates", requireAuth, (_req, res) => {
  const rates = db.prepare(`SELECT effective_year AS effectiveYear, position,
    salary_grade AS salaryGrade, basic_salary AS basicSalary,
    annual_total AS annualTotal, monthly_total AS monthlyTotal,
    daily_rate AS dailyRate, halfday_rate AS halfdayRate, hourly_rate AS hourlyRate
    FROM salary_rates WHERE effective_year=2026 ORDER BY salary_grade`).all();
  res.json({ effectiveYear: 2026, rates });
});



app.get("/api/years", requireAuth, (_req, res) => {
  const years = db.prepare(`
    SELECT y.year, y.status, y.created_at AS createdAt,
      (SELECT COUNT(*) FROM activities a WHERE a.year_id=y.year) AS activityCount
    FROM reporting_years y ORDER BY y.year DESC
  `).all();
  res.json({ years });
});
app.post("/api/years", requireAuth, requireAdmin, (req, res) => {
  const year = Number(req.body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    return res.status(400).json({ error: "Enter a valid year from 2000 to 2200." });
  }
  try {
    db.prepare("INSERT INTO reporting_years(year,status) VALUES (?, 'active')").run(year);
    res.status(201).json({ year, status: "active", message: "New blank year created. Previous years were preserved." });
  } catch {
    res.status(409).json({ error: "That reporting year already exists." });
  }
});
app.patch("/api/years/:year/archive", requireAuth, requireAdmin, (req, res) => {
  const year = Number(req.params.year);
  const result = db.prepare("UPDATE reporting_years SET status='archived' WHERE year=?").run(year);
  if (!result.changes) return res.status(404).json({ error: "Reporting year not found." });
  res.json({ ok: true });
});


app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
  res.json({ user: req.session.user });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.session.user }));

app.get("/api/users", requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name AS displayName, role, active, created_at AS createdAt
    FROM users ORDER BY id
  `).all();
  res.json({ users });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body.username || "").trim();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "encoder";
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Username must be 3–30 characters and use letters, numbers, dot, underscore, or hyphen." });
  if (displayName.length < 2) return res.status(400).json({ error: "Enter a display name." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const result = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run(username, displayName, bcrypt.hashSync(password, 12), role);
    res.status(201).json({ id: result.lastInsertRowid, message: "User created." });
  } catch {
    res.status(409).json({ error: "That username already exists." });
  }
});

app.patch("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const displayName = String(req.body.displayName || "").trim();
  if (displayName.length < 2) return res.status(400).json({ error: "Enter a valid display name." });
  const result = db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, id);
  if (!result.changes) return res.status(404).json({ error: "User not found." });
  res.json({ ok: true });
});
app.post("/api/users/:id/reset-password", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const result = db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password, 12), id);
  if (!result.changes) return res.status(404).json({ error: "User not found." });
  res.json({ ok: true });
});

app.patch("/api/users/:id/status", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const active = req.body.active ? 1 : 0;
  if (id === req.session.user.id && !active) return res.status(400).json({ error: "You cannot deactivate your own account." });
  const result = db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, id);
  if (!result.changes) return res.status(404).json({ error: "User not found." });
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: "You cannot delete your own account." });
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (!result.changes) return res.status(404).json({ error: "User not found." });
  res.json({ ok: true });
});

app.get("/api/users/export.csv", requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT id, username, display_name, role, active, created_at FROM users ORDER BY id").all();
  const headers = ["id", "username", "display_name", "role", "active", "created_at"];
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers.join(","), ...rows.map(row => headers.map(h => quote(row[h])).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="dces-users.csv"');
  res.send("\uFEFF" + csv);
});


function canReadActivity(req, activity) {
  return req.session.user.role === "admin" || activity.created_by === req.session.user.id;
}
app.get("/api/activities", requireAuth, (req, res) => {
  const year = Number(req.query.year || 2027);
  const rows = req.session.user.role === "admin"
    ? db.prepare("SELECT * FROM activities WHERE year_id=? ORDER BY updated_at DESC").all(year)
    : db.prepare("SELECT * FROM activities WHERE year_id=? AND created_by = ? ORDER BY updated_at DESC").all(year, req.session.user.id);
  res.json({ activities: rows });
});
app.post("/api/activities", requireAuth, (req, res) => {
  const d = req.body || {};
  const activityId = String(d.activity_id || "").trim().toUpperCase();
  const activityName = String(d.gad_activity || "").trim();
  if (!/^EX-\d{3,}$/.test(activityId)) return res.status(400).json({ error: "Activity ID must follow EX-001 format." });
  if (!activityName) return res.status(400).json({ error: "GAD Activity is required." });
  const fields = [
    "activity_id","scope","program_classification","gad_mandate","gender_issue","cause_gender_issue","gad_activity","objectives","performance_indicators",
    "targets_female","targets_male","targets_na","budget_nep","nep_cost_breakdown","nep_justification",
    "gaa_female","gaa_male","gaa_na","budget_gaa","gaa_cost_breakdown","gaa_justification","variance_remarks",
    "actual_female","actual_male","actual_na","actual_results","status","actual_cost","actual_cost_breakdown","actual_justification","actual_variance","budget_source","responsible_unit"
  ];
  const vals = fields.map(k => d[k] ?? null);
  const year = Number(req.body.year || 2027);
  if (!db.prepare("SELECT year FROM reporting_years WHERE year=?").get(year)) return res.status(400).json({ error: "Select an existing reporting year." });
  try {
    const result = db.prepare(`INSERT INTO activities (${fields.join(",")},year_id,created_by) VALUES (${fields.map(()=>"?").join(",")},?,?)`).run(...vals, year, req.session.user.id);
    res.status(201).json({ id: result.lastInsertRowid, activity_id: activityId });
  } catch (e) { res.status(409).json({ error: e.message.includes("UNIQUE") ? "Activity ID already exists." : "Unable to save activity." }); }
});
app.put("/api/activities/:activityId", requireAuth, (req, res) => {
  const old = db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if (!old) return res.status(404).json({ error: "Activity not found." });
  if (!canReadActivity(req, old)) return res.status(403).json({ error: "Not allowed." });
  const fields = [
    "scope","program_classification","gad_mandate","gender_issue","cause_gender_issue","gad_activity","objectives","performance_indicators",
    "targets_female","targets_male","targets_na","budget_nep","nep_cost_breakdown","nep_justification",
    "gaa_female","gaa_male","gaa_na","budget_gaa","gaa_cost_breakdown","gaa_justification","variance_remarks",
    "actual_female","actual_male","actual_na","actual_results","status","actual_cost","actual_cost_breakdown","actual_justification","actual_variance","budget_source","responsible_unit"
  ];
  const vals = fields.map(k => req.body[k] ?? null);
  db.prepare(`UPDATE activities SET ${fields.map(k=>`${k}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE activity_id=?`).run(...vals, req.params.activityId);
  res.json({ ok: true });
});
app.get("/api/activities/:activityId", requireAuth, (req, res) => {
  const activity = db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if (!activity) return res.status(404).json({ error: "Activity not found." });
  if (!canReadActivity(req, activity)) return res.status(403).json({ error: "Not allowed." });
  const budgetLines = db.prepare("SELECT * FROM budget_lines WHERE activity_id=? ORDER BY id").all(req.params.activityId);
  const utilization = db.prepare("SELECT * FROM utilization WHERE activity_id=? ORDER BY month,id").all(req.params.activityId);
  res.json({ activity, budgetLines, utilization });
});
app.post("/api/activities/:activityId/budget-lines", requireAuth, (req, res) => {
  const a = db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if (!a) return res.status(404).json({error:"Activity not found."});
  if (!canReadActivity(req,a)) return res.status(403).json({error:"Not allowed."});
  const d=req.body||{};
  let salaryGrade = d.salary_grade || "";
  let hourlyRate = Number(d.hourly_rate)||0;
  let amount = Number(d.amount)||0;
  const staffCount = Number(d.staff_count)||0, hours = Number(d.hours)||0, patients = Number(d.patients)||0;
  if (d.category === "PS") {
    const rate = db.prepare("SELECT salary_grade,hourly_rate FROM salary_rates WHERE effective_year=2026 AND position=?").get(d.position||"");
    if (!rate) return res.status(400).json({error:"Select a valid position from the Salary Grade reference list."});
    salaryGrade = String(rate.salary_grade);
    hourlyRate = rate.hourly_rate;
    amount = Math.round(hourlyRate * hours * staffCount * (patients > 0 ? patients : 1) * 100) / 100;
    if (!d.notes) {
      const totalRate = Math.round(hourlyRate * hours * 100) / 100;
      const patientPart = patients > 0 ? ` x ${patients} patients` : "";
      d.notes = `${d.position} (${staffCount}) x ${totalRate.toFixed(2)} (${hours} hrs x ${hourlyRate.toFixed(2)})${patientPart}`;
    }
  }
  const result=db.prepare(`INSERT INTO budget_lines(activity_id,category,item,position,staff_count,hours,patients,salary_grade,hourly_rate,amount,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.activityId,d.category,d.item||d.position||"",d.position||"",staffCount,hours,patients,salaryGrade,hourlyRate,amount,d.notes||"");
  res.status(201).json({id:result.lastInsertRowid});
});
app.delete("/api/budget-lines/:id", requireAuth, requireAdmin, (req,res)=>{
  db.prepare("DELETE FROM budget_lines WHERE id=?").run(Number(req.params.id)); res.json({ok:true});
});
app.post("/api/activities/:activityId/utilization", requireAuth, (req, res) => {
  const a=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if(!a) return res.status(404).json({error:"Activity not found."});
  if(!canReadActivity(req,a)) return res.status(403).json({error:"Not allowed."});
  const d=req.body||{}, month=Number(d.month);
  if(month<1||month>12) return res.status(400).json({error:"Select a valid month."});
  let salaryGrade = d.salary_grade || "";
  let hourlyRate = Number(d.hourly_rate)||0;
  let amount = Number(d.amount)||0;
  const staffCount = Number(d.staff_count)||0, hours = Number(d.hours)||0, patients = Number(d.patients)||0;
  if (d.category === "PS") {
    const rate = db.prepare("SELECT salary_grade,hourly_rate FROM salary_rates WHERE effective_year=2026 AND position=?").get(d.position||"");
    if (!rate) return res.status(400).json({error:"Select a valid position from the Salary Grade reference list."});
    salaryGrade = String(rate.salary_grade);
    hourlyRate = rate.hourly_rate;
    amount = Math.round(hourlyRate * hours * staffCount * (patients > 0 ? patients : 1) * 100) / 100;
    if (!d.notes) {
      const totalRate = Math.round(hourlyRate * hours * 100) / 100;
      const patientPart = patients > 0 ? ` x ${patients} patients` : "";
      d.notes = `${d.position} (${staffCount}) x ${totalRate.toFixed(2)} (${hours} hrs x ${hourlyRate.toFixed(2)})${patientPart}`;
    }
  }
  const result=db.prepare(`INSERT INTO utilization(activity_id,month,category,item,position,staff_count,hours,patients,salary_grade,hourly_rate,amount,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.activityId,month,d.category,d.item||d.position||"",d.position||"",staffCount,hours,patients,salaryGrade,hourlyRate,amount,d.notes||"",req.session.user.id);
  res.status(201).json({id:result.lastInsertRowid});
});
app.get("/api/reports/summary", requireAuth, (req,res)=>{
  const year = Number(req.query.year || 2027);
  const owner = req.session.user.role==="admin" ? "" : " AND created_by = ?";
  const params = req.session.user.role==="admin" ? [year] : [year, req.session.user.id];
  const activities=db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(budget_nep),0) nep, COALESCE(SUM(budget_gaa),0) gaa, COALESCE(SUM(actual_cost),0) actual FROM activities WHERE year_id=?${owner}`).get(...params);
  const utilWhere = req.session.user.role==="admin" ? "" : " AND u.created_by = ?";
  const monthly=db.prepare(`SELECT u.month,COALESCE(SUM(u.amount),0) total FROM utilization u JOIN activities a ON a.activity_id=u.activity_id WHERE a.year_id=?${utilWhere} GROUP BY u.month ORDER BY u.month`).all(...params);
  res.json({activities,monthly});
});
app.get("/api/reports/activities.csv", requireAuth, (req,res)=>{
  const year = Number(req.query.year || 2027);
  const rows=req.session.user.role==="admin"
    ? db.prepare("SELECT * FROM activities WHERE year_id=? ORDER BY activity_id").all(year)
    : db.prepare("SELECT * FROM activities WHERE year_id=? AND created_by=? ORDER BY activity_id").all(year, req.session.user.id);
  const cols=rows.length?Object.keys(rows[0]):["activity_id","gad_activity","budget_nep","budget_gaa","actual_cost","status"];
  const q=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const csv=[cols.join(","),...rows.map(r=>cols.map(c=>q(r[c])).join(","))].join("\\r\\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="dces-activities-${year}.csv"`);
  res.send("\\uFEFF"+csv);
});

const frontendDist = path.resolve(__dirname, "dist");
app.use(express.static(frontendDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(frontendDist, "index.html"), err => { if (err) next(); });
});

app.listen(PORT, () => console.log(`DCES server running on port ${PORT}`));

