import express from "express";
import cors from "cors";
import session from "express-session";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import fs from "node:fs";
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
function requireRole(...roles) {
  return (req,res,next) => roles.includes(req.session.user?.role) ? next() : res.status(403).json({error:"Your account does not have permission for this action."});
}
function canEditActivity(req, activity) {
  return req.session.user.role === "admin" || (req.session.user.role === "encoder" && activity.department_id === req.session.user.departmentId && ["draft","returned"].includes(activity.workflow_status || "draft"));
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "DCES Demo API", storage: "ephemeral-sqlite", demoOnly: true }));


app.get("/api/salary-rates", requireAuth, (req, res) => {
  const reportingDate = `${Number(req.query.year || new Date().getFullYear())}-01-01`;
  const schedule = db.prepare("SELECT * FROM salary_schedules WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC,id DESC LIMIT 1").get(reportingDate,reportingDate)
    || db.prepare("SELECT * FROM salary_schedules WHERE effective_from <= ? ORDER BY effective_from DESC,id DESC LIMIT 1").get(reportingDate);
  const rates = schedule ? db.prepare(`SELECT position,salary_grade AS salaryGrade,basic_salary AS basicSalary,
    monthly_rate AS monthlyTotal,hourly_rate AS hourlyRate FROM salary_schedule_rates WHERE schedule_id=? ORDER BY salary_grade,position`).all(schedule.id) : [];
  res.json({ effectiveYear: schedule ? Number(String(schedule.effective_from).slice(0,4)) : null, schedule, rates });
});
app.get("/api/salary-schedules", requireAuth, (_req,res)=>{
  const schedules=db.prepare("SELECT s.*,COUNT(r.id) AS rateCount FROM salary_schedules s LEFT JOIN salary_schedule_rates r ON r.schedule_id=s.id GROUP BY s.id ORDER BY s.effective_from DESC,s.id DESC").all();
  res.json({schedules});
});
app.post("/api/salary-schedules", requireAuth, requireAdmin, (req,res)=>{
  const name=String(req.body.name||"").trim(), effectiveFrom=String(req.body.effectiveFrom||"").trim();
  const rates=Array.isArray(req.body.rates)?req.body.rates:[];
  if(!name||!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)||!rates.length) return res.status(400).json({error:"Provide a schedule name, valid effectivity date, and at least one salary rate."});
  const create=db.transaction(()=>{
    const info=db.prepare("INSERT INTO salary_schedules(schedule_name,effective_from,created_by) VALUES(?,?,?)").run(name,effectiveFrom,req.session.user.id);
    const id=Number(info.lastInsertRowid);
    const insert=db.prepare("INSERT INTO salary_schedule_rates(schedule_id,position,salary_grade,basic_salary,monthly_rate,hourly_rate) VALUES(?,?,?,?,?,?)");
    const audit=db.prepare("INSERT INTO salary_rate_audit(schedule_id,position,salary_grade,monthly_rate,action,changed_by) VALUES(?,?,?,?,?,?)");
    for(const r of rates){const position=String(r.position||"").trim(),sg=Number(r.salaryGrade),monthly=Number(r.monthlyRate),basic=Number(r.basicSalary??monthly),hourly=Number(r.hourlyRate||0);if(!position||!Number.isInteger(sg)||sg<1||!Number.isFinite(monthly)||monthly<0)throw new Error("Each rate needs a position, valid salary grade, and non-negative monthly rate.");insert.run(id,position,sg,basic,monthly,hourly);audit.run(id,position,sg,monthly,"created",req.session.user.id);}
    return id;
  });
  try{const id=create();res.status(201).json({id,message:"Salary schedule created. Existing schedules were preserved."});}catch(e){res.status(400).json({error:e.message||"Unable to create schedule."});}
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
  const department = user.department_id ? db.prepare("SELECT id,name,code,reference_no FROM departments WHERE id=?").get(user.department_id) : null;
  req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role,
    departmentId: department?.id || null, departmentName: department?.name || "", departmentCode: department?.code || "", departmentNumber: department?.reference_no || "" };
  res.json({ user: req.session.user });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.session.user }));

app.get("/api/departments", requireAuth, (_req,res) => {
  res.json({ departments: db.prepare("SELECT id,name,code,reference_no AS referenceNo FROM departments ORDER BY CAST(reference_no AS INTEGER),name").all() });
});

app.get("/api/users", requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT u.id,u.username,u.display_name AS displayName,u.role,u.active,u.created_at AS createdAt,
      u.department_id AS departmentId,d.name AS departmentName,d.code AS departmentCode
    FROM users u LEFT JOIN departments d ON d.id=u.department_id ORDER BY u.id
  `).all();
  res.json({ users });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body.username || "").trim();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  const allowedRoles = ["admin","encoder","technical","finance"];
  const role = allowedRoles.includes(req.body.role) ? req.body.role : "encoder";
  const departmentId = Number(req.body.departmentId);
  if (!Number.isInteger(departmentId) || !db.prepare("SELECT id FROM departments WHERE id=?").get(departmentId)) return res.status(400).json({ error: "Select a department for this account." });
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Username must be 3–30 characters and use letters, numbers, dot, underscore, or hyphen." });
  if (displayName.length < 2) return res.status(400).json({ error: "Enter a display name." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const result = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role, department_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, displayName, bcrypt.hashSync(password, 12), role, departmentId);
    res.status(201).json({ id: result.lastInsertRowid, message: "User created." });
  } catch {
    res.status(409).json({ error: "That username already exists." });
  }
});

app.patch("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const displayName = String(req.body.displayName || "").trim();
  if (displayName.length < 2) return res.status(400).json({ error: "Enter a valid display name." });
  const departmentId = Number(req.body.departmentId);
  if (!Number.isInteger(departmentId) || !db.prepare("SELECT id FROM departments WHERE id=?").get(departmentId)) return res.status(400).json({ error: "Select a valid department." });
  const result = db.prepare("UPDATE users SET display_name=?,department_id=? WHERE id=?").run(displayName, departmentId, id);
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
  return ["admin","technical","finance"].includes(req.session.user.role) || activity.department_id === req.session.user.departmentId || activity.created_by === req.session.user.id;
}
app.get("/api/activities", requireAuth, (req, res) => {
  const year = Number(req.query.year || 2027);
  const rows = ["admin","technical","finance"].includes(req.session.user.role)
    ? db.prepare("SELECT a.*,d.name AS department_name,d.code AS department_code,COALESCE((SELECT SUM(u.amount) FROM utilization u WHERE u.activity_id=a.activity_id),0) AS utilization_total FROM activities a LEFT JOIN departments d ON d.id=a.department_id WHERE a.year_id=? ORDER BY a.updated_at DESC").all(year)
    : db.prepare("SELECT a.*,d.name AS department_name,d.code AS department_code,COALESCE((SELECT SUM(u.amount) FROM utilization u WHERE u.activity_id=a.activity_id),0) AS utilization_total FROM activities a LEFT JOIN departments d ON d.id=a.department_id WHERE a.year_id=? AND a.department_id = ? ORDER BY a.updated_at DESC").all(year, req.session.user.departmentId || req.session.user.id);
  res.json({ activities: rows });
});
app.post("/api/activities", requireAuth, requireRole("admin","encoder"), (req, res) => {
  const d = req.body || {};
  const activityName = String(d.gad_activity || "").trim();
  const departmentId = req.session.user.departmentId || Number(d.department_id);
  const department = db.prepare("SELECT id,code,reference_no,name FROM departments WHERE id=?").get(departmentId);
  if (!department) return res.status(400).json({ error: "Your account must have a department assigned before encoding activities." });
  if (!activityName) return res.status(400).json({ error: "GAD Activity is required." });
  const fields = [
    "activity_type","scope","program_classification","gad_agenda_subgoals","org_focus","client_focus_activity","attributable_programs","gad_mandate","gender_issue","cause_gender_issue","gad_activity","objectives","performance_indicators","ps_budget","mooe_budget",
    "targets_female","targets_male","targets_na","budget_nep","nep_cost_breakdown","nep_justification",
    "gaa_female","gaa_male","gaa_na","budget_gaa","gaa_cost_breakdown","gaa_justification","variance_remarks",
    "actual_female","actual_male","actual_na","actual_results","status","actual_cost","actual_cost_breakdown","actual_justification","actual_variance","budget_source","responsible_unit"
  ];
  const vals = fields.map(k => k === "responsible_unit" ? department.name : (d[k] ?? null));
  const accomplishmentText = [d.actual_female,d.actual_male,d.actual_na,d.actual_results,d.actual_cost,d.actual_cost_breakdown,d.actual_variance].some(v=>String(v||"").trim()&&String(v||"")!=="0");
  const autoStatus = String(d.actual_justification||"").trim() ? "Finished" : (String(d.status||"")==="On Process" || accomplishmentText) ? "On Process" : "Not Started";
  vals[fields.indexOf("status")] = autoStatus;
  const year = Number(req.body.year || 2027);
  if (!db.prepare("SELECT year FROM reporting_years WHERE year=?").get(year)) return res.status(400).json({ error: "Select an existing reporting year." });
  try {
    const create = db.transaction(() => {
      const idPrefix = `${department.code}${String(department.reference_no || department.id).padStart(2,"0")}-`;
      const last = db.prepare("SELECT activity_id FROM activities WHERE department_id=? AND activity_id LIKE ? ORDER BY id DESC LIMIT 1").get(department.id, `${idPrefix}%`);
      const sequence = last ? (Number(String(last.activity_id).split("-").at(-1)) || 0) + 1 : 1;
      const activityId = `${idPrefix}${sequence}`;
      const result = db.prepare(`INSERT INTO activities (activity_id,${fields.join(",")},year_id,created_by,department_id) VALUES (?,${fields.map(()=>"?").join(",")},?,?,?)`).run(activityId,...vals,year,req.session.user.id,department.id);
      return { id: Number(result.lastInsertRowid), activity_id: activityId };
    });
    res.status(201).json(create());
  } catch (e) { res.status(409).json({ error: e.message.includes("UNIQUE") ? "Activity ID sequence conflict. Please retry." : "Unable to save activity." }); }
});
app.put("/api/activities/:activityId", requireAuth, (req, res) => {
  const old = db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if (!old) return res.status(404).json({ error: "Activity not found." });
  if (!canReadActivity(req, old)) return res.status(403).json({ error: "Not allowed." });
  if (!canEditActivity(req, old)) return res.status(403).json({ error: "This activity is read-only or already submitted." });
  const fields = [
    "activity_type","scope","program_classification","gad_agenda_subgoals","org_focus","client_focus_activity","attributable_programs","gad_mandate","gender_issue","cause_gender_issue","gad_activity","objectives","performance_indicators","ps_budget","mooe_budget",
    "targets_female","targets_male","targets_na","budget_nep","nep_cost_breakdown","nep_justification",
    "gaa_female","gaa_male","gaa_na","budget_gaa","gaa_cost_breakdown","gaa_justification","variance_remarks",
    "actual_female","actual_male","actual_na","actual_results","status","actual_cost","actual_cost_breakdown","actual_justification","actual_variance","budget_source","responsible_unit"
  ];
  const vals = fields.map(k => k === "responsible_unit" ? ((req.session.user.role === "admin" ? old.responsible_unit : (req.session.user.departmentName || old.responsible_unit))) : (req.body[k] ?? null));
  const accomplishmentText = [req.body.actual_female,req.body.actual_male,req.body.actual_na,req.body.actual_results,req.body.actual_cost,req.body.actual_cost_breakdown,req.body.actual_variance].some(v=>String(v||"").trim()&&String(v||"")!=="0");
  const autoStatus = String(req.body.actual_justification||"").trim() ? "Finished" : (String(req.body.status||"")==="On Process" || accomplishmentText) ? "On Process" : "Not Started";
  vals[fields.indexOf("status")] = autoStatus;
  db.prepare(`UPDATE activities SET ${fields.map(k=>`${k}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE activity_id=?`).run(...vals, req.params.activityId);
  res.json({ ok: true });
});
app.patch("/api/activities/:activityId/accomplishment", requireAuth, requireRole("admin","encoder"), (req,res)=>{
  const a=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if(!a) return res.status(404).json({error:"Activity not found."});
  if(!canReadActivity(req,a)) return res.status(403).json({error:"You can only update accomplishment reports for your assigned unit."});
  const fields=["actual_female","actual_male","actual_na","actual_results","actual_cost","actual_cost_breakdown","actual_justification","actual_variance","budget_source"];
  const utilizationTotal=Number(db.prepare("SELECT COALESCE(SUM(amount),0) total FROM utilization WHERE activity_id=?").get(req.params.activityId).total||0);
  const vals=fields.map(k=>k==="actual_cost"?utilizationTotal:(req.body[k]??null));
  const inProgress=[req.body.actual_female,req.body.actual_male,req.body.actual_na,req.body.actual_results,req.body.actual_cost,req.body.actual_cost_breakdown,req.body.actual_variance].some(v=>String(v??"").trim()!==""&&String(v??"")!=="0");
  const status=String(req.body.actual_justification||"").trim()?"Finished":(String(req.body.status||"")==="On Process"||inProgress)?"On Process":"Not Started";
  db.prepare(`UPDATE activities SET ${fields.map(k=>`${k}=?`).join(",")},status=?,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?`).run(...vals,status,req.params.activityId);
  res.json({ok:true,status});
});
app.post("/api/activities/:activityId/submit", requireAuth, requireRole("admin","encoder"), (req,res)=>{
  const a=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if(!a||(req.session.user.role!=="admin"&&a.created_by!==req.session.user.id)) return res.status(404).json({error:"Activity not found."});
  if(!["draft","returned"].includes(a.workflow_status||"draft")) return res.status(400).json({error:"Only draft or returned activities can be submitted."});
  db.prepare("UPDATE activities SET workflow_status='submitted',finance_feedback=NULL,admin_feedback=NULL,reviewed_at=NULL,submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(a.activity_id);
  res.json({ok:true});
});
app.post("/api/activities/:activityId/finance-feedback", requireAuth, requireRole("finance"), (req,res)=>{
  const feedback=String(req.body.feedback||"").trim();if(!feedback)return res.status(400).json({error:"Enter review feedback."});
  const a=db.prepare("SELECT id FROM activities WHERE activity_id=?").get(req.params.activityId);if(!a)return res.status(404).json({error:"Activity not found."});
  db.prepare("UPDATE activities SET finance_feedback=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(feedback,req.params.activityId);res.json({ok:true});
});
app.post("/api/activities/:activityId/decision", requireAuth, requireAdmin, (req,res)=>{
  const decision=String(req.body.decision||""), feedback=String(req.body.feedback||"").trim();
  if(!["approved","returned"].includes(decision))return res.status(400).json({error:"Decision must be approved or returned."});
  if(decision==="returned"&&!feedback)return res.status(400).json({error:"A send-back reason is required."});
  const a=db.prepare("SELECT id,workflow_status FROM activities WHERE activity_id=?").get(req.params.activityId);if(!a)return res.status(404).json({error:"Activity not found."});
  if(a.workflow_status!=="submitted")return res.status(400).json({error:"Only submitted activities can be approved or sent back."});
  const financeReview=db.prepare("SELECT finance_feedback FROM activities WHERE activity_id=?").get(req.params.activityId);
  if(decision==="approved"&&!String(financeReview?.finance_feedback||"").trim())return res.status(400).json({error:"Finance review feedback is required before Admin approval."});
  db.prepare("UPDATE activities SET workflow_status=?,admin_feedback=?,approved_by=?,approved_at=CASE WHEN ?='approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(decision,feedback||null,req.session.user.id,decision,req.params.activityId);res.json({ok:true});
});

app.get("/api/activities/:activityId", requireAuth, (req, res) => {
  const activity = db.prepare("SELECT a.*,d.name AS department_name,d.code AS department_code FROM activities a LEFT JOIN departments d ON d.id=a.department_id WHERE a.activity_id=?").get(req.params.activityId);
  if (!activity) return res.status(404).json({ error: "Activity not found." });
  if (!canReadActivity(req, activity)) return res.status(403).json({ error: "Not allowed." });
  const budgetLines = db.prepare("SELECT * FROM budget_lines WHERE activity_id=? ORDER BY id").all(req.params.activityId);
  const utilization = db.prepare("SELECT * FROM utilization WHERE activity_id=? ORDER BY month,id").all(req.params.activityId);
  res.json({ activity, budgetLines, utilization });
});
app.get("/api/budget-lines", requireAuth, (req,res)=>{
  const year=Number(req.query.year||2027), broad=["admin","technical","finance"].includes(req.session.user.role);
  const rows=db.prepare(`SELECT bl.*,a.year_id,a.gad_activity,a.workflow_status,a.created_by,d.name AS department_name,
    CASE WHEN (?='admin' OR (a.department_id=? AND a.workflow_status IN ('draft','returned'))) THEN 1 ELSE 0 END AS can_edit
    FROM budget_lines bl JOIN activities a ON a.activity_id=bl.activity_id LEFT JOIN departments d ON d.id=a.department_id
    WHERE a.year_id=? AND (?=1 OR a.department_id=?) ORDER BY d.name,a.activity_id,bl.category,bl.id`)
    .all(req.session.user.role,req.session.user.departmentId,year,broad?1:0,req.session.user.departmentId);
  res.json({lines:rows});
});
app.get("/api/utilization", requireAuth, (req,res)=>{
  const year=Number(req.query.year||2027), broad=["admin","technical","finance"].includes(req.session.user.role);
  const rows=db.prepare(`SELECT u.*,a.year_id,a.gad_activity,a.workflow_status,a.created_by,d.name AS department_name,
    CASE WHEN (?='admin' OR (a.department_id=? AND a.workflow_status IN ('draft','returned'))) THEN 1 ELSE 0 END AS can_edit,
    a.department_id FROM utilization u JOIN activities a ON a.activity_id=u.activity_id LEFT JOIN departments d ON d.id=a.department_id
    WHERE a.year_id=? AND (?=1 OR a.department_id=?) ORDER BY u.month,d.name,a.activity_id,u.id`)
    .all(req.session.user.role,req.session.user.departmentId,year,broad?1:0,req.session.user.departmentId);
  res.json({entries:rows});
});

app.post("/api/activities/:activityId/budget-lines", requireAuth, requireRole("admin","encoder"), (req, res) => {
  const a = db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if (!a) return res.status(404).json({error:"Activity not found."});
  if (!canReadActivity(req,a)) return res.status(403).json({error:"Not allowed."});
  if (!canEditActivity(req,a)) return res.status(403).json({error:"This activity is read-only or already submitted."});
  const d=req.body||{};
  const isPS = d.category === "PS";
  const isHonoraria = d.category === "HONORARIA";
  const isPatientExpense = d.category === "PATIENT EXPENSE";
  const isQuantityCategory = ["MATERIALS","VENUE/FOOD","PATIENT EXPENSE"].includes(d.category);
  let salaryGrade = isPS ? (d.salary_grade || "") : "";
  let hourlyRate = isPS ? (Number(d.hourly_rate)||0) : 0;
  let amount = Number(d.amount)||0;
  const staffCount = isPS ? (Number(d.staff_count)||0) : 0;
  const hours = (isPS||isHonoraria) ? (Number(d.hours)||0) : 0;
  const patients = (isPS||isPatientExpense) ? (Number(d.patients)||0) : 0;
  const quantity = isQuantityCategory ? (Number(d.quantity)||0) : 0;
  const unitPrice = isQuantityCategory ? (Number(d.unit_price)||0) : 0;
  const ratePerHour = isHonoraria ? (Number(d.rate_per_hour)||0) : 0;
  if (["MATERIALS","VENUE/FOOD"].includes(d.category)) amount=Math.round(quantity*unitPrice*100)/100;
  if (d.category === "PATIENT EXPENSE") amount=Math.round(quantity*unitPrice*patients*100)/100;
  if (d.category === "HONORARIA") amount=Math.round(ratePerHour*hours*100)/100;
  if (d.category === "PS") {
    const rate = db.prepare(`SELECT r.salary_grade,r.hourly_rate FROM salary_schedule_rates r JOIN salary_schedules s ON s.id=r.schedule_id WHERE r.position=? AND s.effective_from<=? AND (s.effective_to IS NULL OR s.effective_to>=?) ORDER BY s.effective_from DESC,s.id DESC LIMIT 1`).get(d.position||"",`${a.year_id}-01-01`,`${a.year_id}-01-01`);
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
  const result=db.prepare(`INSERT INTO budget_lines(activity_id,category,item,position,staff_count,hours,patients,salary_grade,hourly_rate,amount,notes,quantity,unit_price,rate_per_hour) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.activityId,d.category,d.item||d.position||"",d.position||"",staffCount,hours,patients,salaryGrade,hourlyRate,amount,d.notes||"",quantity,unitPrice,ratePerHour);
  const totals=db.prepare(`SELECT COALESCE(SUM(CASE WHEN category='PS' THEN amount ELSE 0 END),0) ps,
    COALESCE(SUM(CASE WHEN category<>'PS' THEN amount ELSE 0 END),0) mooe FROM budget_lines WHERE activity_id=?`).get(req.params.activityId);
  db.prepare("UPDATE activities SET ps_budget=?,mooe_budget=?,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(totals.ps,totals.mooe,req.params.activityId);
  res.status(201).json({id:result.lastInsertRowid,totals});
});
app.put("/api/budget-lines/:id", requireAuth, requireRole("admin","encoder"), (req,res)=>{
  const id=Number(req.params.id), line=db.prepare("SELECT * FROM budget_lines WHERE id=?").get(id);
  if(!line)return res.status(404).json({error:"Budget line not found."});
  const a=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(line.activity_id);
  if(!a||!canEditActivity(req,a))return res.status(403).json({error:"You cannot edit this budget line."});
  const d=req.body||{}, category=String(d.category||line.category), item=String(d.item??line.item??"");
  const isPS=category==="PS", isHonoraria=category==="HONORARIA", isPatientExpense=category==="PATIENT EXPENSE";
  const position=isPS?String(d.position??line.position??""):"";
  const staffCount=isPS?(Number(d.staff_count??line.staff_count)||0):0;
  const hours=(isPS||isHonoraria)?(Number(d.hours??line.hours)||0):0;
  const patients=(isPS||isPatientExpense)?(Number(d.patients??line.patients)||0):0;
  const isQuantityCategory=["MATERIALS","VENUE/FOOD","PATIENT EXPENSE"].includes(category);
  const quantity=isQuantityCategory?(Number(d.quantity??line.quantity)||0):0;
  const unitPrice=isQuantityCategory?(Number(d.unit_price??line.unit_price)||0):0;
  const ratePerHour=isHonoraria?(Number(d.rate_per_hour??line.rate_per_hour)||0):0;
  let salaryGrade=isPS?String(d.salary_grade??line.salary_grade??""):"", hourlyRate=isPS?(Number(d.hourly_rate??line.hourly_rate)||0):0;
  let amount=Number(d.amount??line.amount)||0;
  if(["MATERIALS","VENUE/FOOD"].includes(category))amount=Math.round(quantity*unitPrice*100)/100;
  if(category==="PATIENT EXPENSE")amount=Math.round(quantity*unitPrice*patients*100)/100;
  if(category==="HONORARIA")amount=Math.round(ratePerHour*hours*100)/100;
  if(category==="PS"){
    const rate=db.prepare(`SELECT r.salary_grade,r.hourly_rate FROM salary_schedule_rates r JOIN salary_schedules s ON s.id=r.schedule_id WHERE r.position=? AND s.effective_from<=? AND (s.effective_to IS NULL OR s.effective_to>=?) ORDER BY s.effective_from DESC,s.id DESC LIMIT 1`).get(position,`${a.year_id}-01-01`,`${a.year_id}-01-01`);
    if(!rate)return res.status(400).json({error:"Select a valid position from the Salary Grade reference list."});
    salaryGrade=String(rate.salary_grade);hourlyRate=Number(rate.hourly_rate);
    amount=Math.round(hourlyRate*hours*staffCount*(patients>0?patients:1)*100)/100;
  }
  db.prepare("UPDATE budget_lines SET category=?,item=?,position=?,staff_count=?,hours=?,patients=?,salary_grade=?,hourly_rate=?,amount=?,notes=?,quantity=?,unit_price=?,rate_per_hour=? WHERE id=?")
    .run(category,item,position,staffCount,hours,patients,salaryGrade,hourlyRate,amount,String(d.notes??line.notes??""),quantity,unitPrice,ratePerHour,id);
  const totals=db.prepare("SELECT COALESCE(SUM(CASE WHEN category='PS' THEN amount ELSE 0 END),0) ps,COALESCE(SUM(CASE WHEN category<>'PS' THEN amount ELSE 0 END),0) mooe FROM budget_lines WHERE activity_id=?").get(line.activity_id);
  db.prepare("UPDATE activities SET ps_budget=?,mooe_budget=?,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(totals.ps,totals.mooe,line.activity_id);
  res.json({ok:true,totals,amount});
});
app.delete("/api/budget-lines/:id", requireAuth, requireRole("admin","encoder"), (req,res)=>{
  const line=db.prepare("SELECT activity_id FROM budget_lines WHERE id=?").get(Number(req.params.id));
  if(!line)return res.status(404).json({error:"Budget line not found."});
  const activity=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(line.activity_id);
  if(!activity||!canEditActivity(req,activity))return res.status(403).json({error:"You cannot delete this budget line."});
  db.prepare("DELETE FROM budget_lines WHERE id=?").run(Number(req.params.id));
  const totals=db.prepare(`SELECT COALESCE(SUM(CASE WHEN category='PS' THEN amount ELSE 0 END),0) ps,COALESCE(SUM(CASE WHEN category<>'PS' THEN amount ELSE 0 END),0) mooe FROM budget_lines WHERE activity_id=?`).get(line.activity_id);
  db.prepare("UPDATE activities SET ps_budget=?,mooe_budget=?,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(totals.ps,totals.mooe,line.activity_id);
  res.json({ok:true,totals});
});
app.post("/api/activities/:activityId/utilization", requireAuth, requireRole("admin","encoder"), (req, res) => {
  const a=db.prepare("SELECT * FROM activities WHERE activity_id=?").get(req.params.activityId);
  if(!a) return res.status(404).json({error:"Activity not found."});
  if(!canReadActivity(req,a)) return res.status(403).json({error:"Not allowed."});
  if(!canEditActivity(req,a)) return res.status(403).json({error:"This activity is read-only or already submitted."});
  const d=req.body||{}, month=Number(d.month);
  if(month<1||month>12) return res.status(400).json({error:"Select a valid month."});
  const isPS = d.category === "PS";
  const isHonoraria = d.category === "HONORARIA";
  const isPatientExpense = d.category === "PATIENT EXPENSE";
  const isQuantityCategory = ["MATERIALS","VENUE/FOOD","PATIENT EXPENSE"].includes(d.category);
  let salaryGrade = isPS ? (d.salary_grade || "") : "";
  let hourlyRate = isPS ? (Number(d.hourly_rate)||0) : 0;
  let amount = Number(d.amount)||0;
  const staffCount = isPS ? (Number(d.staff_count)||0) : 0;
  const hours = (isPS||isHonoraria) ? (Number(d.hours)||0) : 0;
  const patients = (isPS||isPatientExpense) ? (Number(d.patients)||0) : 0;
  const quantity = isQuantityCategory ? (Number(d.quantity)||0) : 0;
  const unitPrice = isQuantityCategory ? (Number(d.unit_price)||0) : 0;
  const ratePerHour = isHonoraria ? (Number(d.rate_per_hour)||0) : 0;
  if (["MATERIALS","VENUE/FOOD"].includes(d.category)) amount=Math.round(quantity*unitPrice*100)/100;
  if (d.category === "PATIENT EXPENSE") amount=Math.round(quantity*unitPrice*patients*100)/100;
  if (d.category === "HONORARIA") amount=Math.round(ratePerHour*hours*100)/100;
  if (d.category === "PS") {
    const rate = db.prepare(`SELECT r.salary_grade,r.hourly_rate FROM salary_schedule_rates r JOIN salary_schedules s ON s.id=r.schedule_id WHERE r.position=? AND s.effective_from<=? AND (s.effective_to IS NULL OR s.effective_to>=?) ORDER BY s.effective_from DESC,s.id DESC LIMIT 1`).get(d.position||"",`${a.year_id}-01-01`,`${a.year_id}-01-01`);
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
  const result=db.prepare(`INSERT INTO utilization(activity_id,month,category,item,position,staff_count,hours,patients,salary_grade,hourly_rate,amount,notes,created_by,quantity,unit_price,rate_per_hour) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.params.activityId,month,d.category,d.item||d.position||"",d.position||"",staffCount,hours,patients,salaryGrade,hourlyRate,amount,d.notes||"",req.session.user.id,quantity,unitPrice,ratePerHour);
  const utilizationTotal=Number(db.prepare("SELECT COALESCE(SUM(amount),0) total FROM utilization WHERE activity_id=?").get(req.params.activityId).total||0);
  db.prepare("UPDATE activities SET actual_cost=?,updated_at=CURRENT_TIMESTAMP WHERE activity_id=?").run(utilizationTotal,req.params.activityId);
  res.status(201).json({id:result.lastInsertRowid,utilizationTotal});
});
app.get("/api/reports/summary", requireAuth, (req,res)=>{
  const year = Number(req.query.year || 2027);
  const broadAccess = ["admin","technical","finance"].includes(req.session.user.role);
  const owner = broadAccess ? "" : " AND department_id = ?";
  const params = broadAccess ? [year] : [year, req.session.user.departmentId];
  const activities=db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(budget_nep),0) nep, COALESCE(SUM(budget_gaa),0) gaa, COALESCE((SELECT SUM(u.amount) FROM utilization u WHERE u.activity_id IN (SELECT activity_id FROM activities aa WHERE aa.year_id=? AND aa.workflow_status='approved'${owner})),0) actual FROM activities WHERE year_id=? AND workflow_status='approved'${owner}`).get(...(broadAccess?[year,year]:[year,year,req.session.user.departmentId,req.session.user.departmentId]));
  const utilWhere = broadAccess ? "" : " AND a.department_id = ?";
  const monthly=db.prepare(`SELECT u.month,COALESCE(SUM(u.amount),0) total FROM utilization u JOIN activities a ON a.activity_id=u.activity_id WHERE a.year_id=?${utilWhere} GROUP BY u.month ORDER BY u.month`).all(...params);
  res.json({activities,monthly});
});
app.get("/api/reports/activities.csv", requireAuth, (req,res)=>{
  const year = Number(req.query.year || 2027);
  const rows=["admin","technical","finance"].includes(req.session.user.role)
    ? db.prepare("SELECT * FROM activities WHERE year_id=? ORDER BY activity_id").all(year)
    : db.prepare("SELECT * FROM activities WHERE year_id=? AND department_id=? ORDER BY activity_id").all(year, req.session.user.departmentId);
  // Stable GPB export schema: include every encoding field even when the year has no records.
  const columns = [
    ["activity_id","Activity ID"],["scope","Scope of Activity"],["program_classification","GAD Agenda Subgoals"],["gad_agenda_subgoals","GAD Agenda Subgoals (Detail)"],
    ["gad_mandate","GAD Mandate"],["gender_issue","Gender Issue"],["cause_gender_issue","Cause of Gender Issue"],["gad_activity","GAD Activity"],
    ["org_focus","Org Focus"],["client_focus_activity","Client Focus Activity"],["attributable_programs","Attributable Programs"],
    ["objectives","GAD Objectives"],["performance_indicators","Performance Indicators"],["ps_budget","PS Budget"],["mooe_budget","MOOE Budget"],
    ["targets_female","NEP Target - Female"],["targets_male","NEP Target - Male"],["targets_na","NEP Target - N/A"],["budget_nep","NEP Budget"],["nep_cost_breakdown","NEP Cost Breakdown"],["nep_justification","NEP Justification"],
    ["gaa_female","GAA Target - Female"],["gaa_male","GAA Target - Male"],["gaa_na","GAA Target - N/A"],["budget_gaa","GAA Budget"],["gaa_cost_breakdown","GAA Cost Breakdown"],["gaa_justification","GAA Justification"],["variance_remarks","Variance Remarks"],
    ["actual_female","Actual - Female"],["actual_male","Actual - Male"],["actual_na","Actual - N/A"],["actual_results","Actual Results"],["status","Status"],["actual_cost","Actual Cost / Expenditure"],["actual_cost_breakdown","Actual Cost Breakdown"],["actual_justification","Actual Justification"],["actual_variance","Actual Variance"],["budget_source","Source of Budget"],["responsible_unit","Responsible Unit"]
  ];
  const quote = value => `"${String(value ?? "").replaceAll('"','""')}"`;
  const csv = [columns.map(([,label])=>quote(label)).join(","), ...rows.map(row=>columns.map(([key])=>quote(row[key])).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="dces-gpb-${year}.csv"`);
  res.send("\uFEFF" + csv);
});


function exportRowsForUser(req, year) {
  const broad = ["admin","technical","finance"].includes(req.session.user.role);
  const base = broad
    ? db.prepare("SELECT a.*,d.name AS department_name,d.code AS department_code,COALESCE((SELECT SUM(u.amount) FROM utilization u WHERE u.activity_id=a.activity_id),0) utilization_total FROM activities a LEFT JOIN departments d ON d.id=a.department_id WHERE a.year_id=? ORDER BY d.name,a.activity_id").all(year)
    : db.prepare("SELECT a.*,d.name AS department_name,d.code AS department_code,COALESCE((SELECT SUM(u.amount) FROM utilization u WHERE u.activity_id=a.activity_id),0) utilization_total FROM activities a LEFT JOIN departments d ON d.id=a.department_id WHERE a.year_id=? AND a.department_id=? ORDER BY a.activity_id").all(year,req.session.user.departmentId);
  const selected = String(req.query.activityIds || "").split(",").map(x=>x.trim()).filter(Boolean);
  return selected.length ? base.filter(a=>selected.includes(a.activity_id)) : base;
}
function accomplishmentStatus(a){
  if(String(a.actual_justification||"").trim()) return "Finished";
  const inProgress=[a.actual_female,a.actual_male,a.actual_na,a.actual_results,a.actual_cost,a.actual_cost_breakdown,a.actual_variance].some(v=>String(v??"").trim()!==""&&String(v??"")!=="0");
  return String(a.status||"")==="On Process"||inProgress ? "On Process" : "Not Started";
}
app.get("/api/exports/preview", requireAuth, (req,res)=>{
  const year=Number(req.query.year||2027), rows=exportRowsForUser(req,year);
  const ids=rows.map(a=>a.activity_id);
  const budget=ids.length?db.prepare(`SELECT bl.*,a.gad_activity,a.department_id,d.name department_name FROM budget_lines bl JOIN activities a ON a.activity_id=bl.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE bl.activity_id IN (${ids.map(()=>"?").join(",")}) ORDER BY a.activity_id,bl.category,bl.id`).all(...ids):[];
  const utilization=ids.length?db.prepare(`SELECT u.*,a.gad_activity,a.department_id,d.name department_name FROM utilization u JOIN activities a ON a.activity_id=u.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE u.activity_id IN (${ids.map(()=>"?").join(",")}) ORDER BY a.activity_id,u.month,u.category,u.id`).all(...ids):[];
  res.json({activities:rows,budgetLines:budget,utilization,counts:{activities:rows.length,budgetLines:budget.length,utilization:utilization.length}});
});
app.get("/api/exports/accomplishments.csv", requireAuth, (req,res)=>{
  const year=Number(req.query.year||2027), rows=exportRowsForUser(req,year).map(a=>({...a,status:accomplishmentStatus(a)}));
  const cols=[["activity_id","Activity ID"],["department_name","Responsible Unit"],["gad_activity","GAAD Activity"],["actual_female","Actual Female"],["actual_male","Actual Male"],["actual_na","Actual N/A"],["actual_results","Actual Results"],["status","Accomplishment Status"],["actual_cost","Actual Cost"],["actual_cost_breakdown","Actual Cost Breakdown"],["actual_justification","Justification"],["actual_variance","Variance Remarks"]];
  const quote=v=>`"${String(v??"").replaceAll('"','""')}"`;const csv=[cols.map(c=>quote(c[1])).join(","),...rows.map(a=>cols.map(c=>quote(a[c[0]])).join(","))].join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="DCES-Accomplishment-Report-${year}.csv"`);res.send("\uFEFF"+csv);
} );
app.get("/api/exports/gpb.xlsx", requireAuth, async (req,res) => {
  try {
    const year=Number(req.query.year||2027), rows=exportRowsForUser(req,year);
    const templatePath=path.resolve(__dirname,"../reference-workbooks/GAD GPB AND AR TEMPLATE.xlsx");
    const wb=new ExcelJS.Workbook();
    if(fs.existsSync(templatePath)) await wb.xlsx.readFile(templatePath);
    else { const ws=wb.addWorksheet("GPB (To Print)"); ws.addRow(["ANNUAL GENDER AND DEVELOPMENT (GAD) PLAN AND BUDGET"]); }
    const ws=wb.getWorksheet("GPB (To Print)")||wb.worksheets[0];
    ws.getCell("A1").value=`ANNUAL GENDER AND DEVELOPMENT (GAD) PLAN AND BUDGET\nFY ${year}`;
    ws.getCell("C3").value="Department of Health - Jose R. Reyes Memorial Medical Center";
    ws.getCell("C5").value=year;
    // Populate the official GPB form's three activity sections while retaining its original merged cells and formatting.
    const sectionRows={client:[11,12,13],organization:[15,16,17],attributable:[19,20,21,22,23]};
    // Remove the sample institution's example rows before inserting DCES records.
    for (const rowNo of [11,12,13,15,16,17,19,20,21,22,23]) for(let col=1;col<=40;col++) ws.getCell(rowNo,col).value=null;
    const used={client:0,organization:0,attributable:0};
    for (const activity of rows) {
      const type=activity.activity_type||(activity.client_focus_activity?"client_focus_activity":activity.attributable_programs?"attributable_programs":"org_focus");
      const kind=type==="client_focus_activity"?"client":type==="attributable_programs"?"attributable":"organization";
      const rowNo=sectionRows[kind][used[kind]++];
      if (!rowNo) {
        // The supplied print sheet has fixed sample capacity (3 client, 3 organization, 5 attributable rows).
        // Keep overflow records in a dedicated continuation sheet rather than silently omitting them.
        const overflow=wb.getWorksheet("GPB Continued")||wb.addWorksheet("GPB Continued");
        if (!overflow.columns.length) overflow.columns=[
          {header:"Activity Type",key:"type",width:24},{header:"Activity ID",key:"activity_id",width:18},
          {header:"Department",key:"department",width:32},{header:"GAD Mandate",key:"mandate",width:36},
          {header:"Gender Issue",key:"issue",width:36},{header:"Cause",key:"cause",width:36},
          {header:"Objective",key:"objective",width:36},{header:"GAD Activity",key:"activity",width:36},
          {header:"Performance Indicators",key:"indicators",width:36},{header:"NEP Budget",key:"nep",width:18},
          {header:"GAA Budget",key:"gaa",width:18},{header:"Responsible Unit",key:"unit",width:30}
        ];
        overflow.addRow({type:kind==="client"?"Client-Focused":kind==="attributable"?"Attributable":"Organization-Focused",activity_id:activity.activity_id,department:activity.department_name,mandate:activity.gad_mandate,issue:activity.gender_issue,cause:activity.cause_gender_issue,objective:activity.objectives,activity:activity.gad_activity,indicators:activity.performance_indicators,nep:Number(activity.budget_nep||0),gaa:Number(activity.budget_gaa||0),unit:activity.responsible_unit});
        continue;
      }
      const values=[
        activity.gad_mandate,activity.gender_issue,activity.cause_gender_issue,activity.objectives,activity.gad_activity,
        activity.performance_indicators,activity.targets_female,activity.targets_male,activity.targets_na,
        [activity.targets_female,activity.targets_male,activity.targets_na].filter(Boolean).join(" / "),
        Number(activity.budget_nep||0),activity.nep_cost_breakdown,activity.nep_justification,activity.variance_remarks,
        activity.gaa_justification,activity.gaa_female,activity.gaa_male,activity.gaa_na,
        [activity.gaa_female,activity.gaa_male,activity.gaa_na].filter(Boolean).join(" / "),Number(activity.budget_gaa||0),
        activity.gaa_justification,activity.variance_remarks,activity.gaa_cost_breakdown,activity.actual_results,
        activity.status,Number(activity.actual_cost||0),activity.actual_justification,activity.actual_variance,
        activity.actual_cost_breakdown,activity.budget_source,null,activity.responsible_unit
      ];
      values.forEach((value,index)=>{if(value!==undefined&&value!==null)ws.getCell(rowNo,index+1).value=value;});
      // Populate the official workbook's dedicated accomplishment-report columns (AG:AN).
      for(let col=24;col<=30;col++) ws.getCell(rowNo,col).value=null;
      for(let col=33;col<=39;col++) ws.getCell(rowNo,col).value=null;
      ws.getCell(rowNo,40).value=null; // Reserved for GFPS Secretariat feedback only.

    }
    // Preserve the official form sheet and add a complete, filterable data worksheet.
    const data=wb.getWorksheet("DCES Export Data")||wb.addWorksheet("DCES Export Data");
    data.columns=[
      {header:"Activity ID",key:"activity_id",width:18},{header:"Activity Type",key:"activity_type",width:24},{header:"Department",key:"department_name",width:34},
      {header:"Scope of Activity",key:"scope",width:24},{header:"GAD Agenda Subgoals",key:"gad_agenda_subgoals",width:28},
      {header:"GAD Mandate",key:"gad_mandate",width:36},{header:"Gender Issue",key:"gender_issue",width:36},
      {header:"Cause of Gender Issue",key:"cause_gender_issue",width:36},{header:"GAD Result Statement / Objective",key:"objectives",width:36},
      {header:"GAD Activities",key:"gad_activity",width:36},{header:"Performance Indicators",key:"performance_indicators",width:36},
      {header:"NEP Target Female",key:"targets_female",width:18},{header:"NEP Target Male",key:"targets_male",width:18},
      {header:"NEP Target N/A",key:"targets_na",width:18},{header:"GAD Budget (NEP)",key:"budget_nep",width:18},
      {header:"Cost Breakdown (NEP)",key:"nep_cost_breakdown",width:36},{header:"GAD Justification (NEP)",key:"nep_justification",width:36},
      {header:"Remarks",key:"variance_remarks",width:30},{header:"GAA Target Female",key:"gaa_female",width:18},
      {header:"GAA Target Male",key:"gaa_male",width:18},{header:"GAA Target N/A",key:"gaa_na",width:18},
      {header:"GAD Budget (GAA)",key:"budget_gaa",width:18},{header:"Cost Breakdown (GAA)",key:"gaa_cost_breakdown",width:36},
      {header:"GAD Justification (GAA)",key:"gaa_justification",width:36},
      {header:"Responsible Unit",key:"responsible_unit",width:28},{header:"Workflow Status",key:"workflow_status",width:18}
    ];
    data.addRows(rows);
    data.views=[{state:"frozen",ySplit:1}];
    data.autoFilter={from:{row:1,column:1},to:{row:1,column:data.columns.length}};
    data.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};
    data.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF17365D"}};
    data.eachRow((row,i)=>{row.alignment={vertical:"top",wrapText:true};if(i>1&&i%2===0)row.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF2F6FA"}};});
    const overflowSheet=wb.getWorksheet("GPB Continued");
    if(overflowSheet){overflowSheet.views=[{state:"frozen",ySplit:1}];overflowSheet.autoFilter={from:{row:1,column:1},to:{row:1,column:overflowSheet.columns.length}};overflowSheet.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};overflowSheet.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF17365D"}};overflowSheet.eachRow((row,i)=>{row.alignment={vertical:"top",wrapText:true};if(i>1&&i%2===0)row.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF2F6FA"}};});}
    const budgetSheet=wb.getWorksheet("Budget Breakdown")||wb.addWorksheet("Budget Breakdown");
    budgetSheet.addRow(["Activity ID","Responsible Unit","GAAD Activity","Category","Category-Specific Itemized Breakdown","Amount","Cost Breakdown / Notes"]);
    const utilizationSheet=wb.getWorksheet("Utilization Breakdown")||wb.addWorksheet("Utilization Breakdown");
    utilizationSheet.addRow(["Activity ID","Responsible Unit","GAAD Activity","Month","Category","Category-Specific Itemized Breakdown","Actual Amount","Cost Breakdown / Notes"]);
    const accomplishments=wb.getWorksheet("Accomplishment Report")||wb.addWorksheet("Accomplishment Report");
    accomplishments.addRow(["Activity ID","Responsible Unit","GAAD Activity","Actual Female","Actual Male","Actual N/A","Actual Results","Status","Actual Cost","Cost Breakdown","Justification","Variance Remarks"]);
    const exportIds=rows.map(a=>a.activity_id);
    const budgetRows=exportIds.length?db.prepare(`SELECT bl.*,a.gad_activity,d.name department_name FROM budget_lines bl JOIN activities a ON a.activity_id=bl.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE bl.activity_id IN (${exportIds.map(()=>"?").join(",")}) ORDER BY a.activity_id,bl.category,bl.id`).all(...exportIds):[];
    const utilRows=exportIds.length?db.prepare(`SELECT u.*,a.gad_activity,d.name department_name FROM utilization u JOIN activities a ON a.activity_id=u.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE u.activity_id IN (${exportIds.map(()=>"?").join(",")}) ORDER BY a.activity_id,u.month,u.category,u.id`).all(...exportIds):[];
    const itemizedBreakdown=r=>{
      const item=String(r.item||"Item");
      if(r.category==="PS")return `${r.position||item} | Staff: ${r.staff_count||0} | Hours: ${r.hours||0} | Patients/Participants: ${r.patients||0} | SG: ${r.salary_grade||"—"} | Hourly rate: ₱${Number(r.hourly_rate||0).toFixed(2)}`;
      if(r.category==="MATERIALS")return `${item} | Quantity: ${r.quantity||0} × Unit price: ₱${Number(r.unit_price||0).toFixed(2)}`;
      if(r.category==="VENUE/FOOD")return `${item} | Packs: ${r.quantity||0} × Price per pack: ₱${Number(r.unit_price||0).toFixed(2)}`;
      if(r.category==="PATIENT EXPENSE")return `${item} | Patients: ${r.patients||0} × Quantity per patient: ${r.quantity||0} × Unit price: ₱${Number(r.unit_price||0).toFixed(2)}`;
      if(r.category==="HONORARIA")return `${item} | Rate per hour: ₱${Number(r.rate_per_hour||0).toFixed(2)} × Hours: ${r.hours||0}`;
      return item;
    };
    for(const r of budgetRows) budgetSheet.addRow([r.activity_id,r.department_name,r.gad_activity,r.category,itemizedBreakdown(r),r.amount,r.notes]);
    for(const r of utilRows) utilizationSheet.addRow([r.activity_id,r.department_name,r.gad_activity,r.month,r.category,itemizedBreakdown(r),r.amount,r.notes]);
    for(const a of rows) accomplishments.addRow([a.activity_id,a.department_name,a.gad_activity,a.actual_female,a.actual_male,a.actual_na,a.actual_results,accomplishmentStatus(a),a.actual_cost,a.actual_cost_breakdown,a.actual_justification,a.actual_variance]);
    for(const sh of [budgetSheet,utilizationSheet,accomplishments]){sh.views=[{state:"frozen",ySplit:1}];sh.getRow(1).font={bold:true};sh.autoFilter={from:{row:1,column:1},to:{row:1,column:sh.columnCount}};sh.columns.forEach(c=>{const vals=(c.values||[]).filter(v=>v!=null).map(v=>String(v).length+2);c.width=Math.min(36,Math.max(14,...vals));});}
    for(let rowNo=2;rowNo<=accomplishments.rowCount;rowNo++){const finished=String(accomplishments.getCell(rowNo,11).value||"").trim();const status=String(accomplishments.getCell(rowNo,8).value||"");const fill=finished?"FFE2F7E8":status==="On Process"?"FFFFF4CC":"FFE5E7EB";accomplishments.getCell(rowNo,8).fill={type:"pattern",pattern:"solid",fgColor:{argb:fill}};}
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="DCES-GPB-${year}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  } catch(e) { console.error(e); res.status(500).json({error:"Unable to generate the Excel export."}); }
});
app.get("/api/exports/gpb.pdf", requireAuth, (req,res) => {
  try {
    const year=Number(req.query.year||2027), rows=exportRowsForUser(req,year);
    const doc=new PDFDocument({size:"A3",layout:"landscape",margin:22,bufferPages:true});
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`attachment; filename="DCES-GPB-${year}.pdf"`);
    doc.pipe(res);
    const navy="#17365D", pale="#DCE6F1", border="#718096", ink="#17212B";
    const left=22, pageW=doc.page.width-44, bottom=doc.page.height-24;
    const cols=[
      ["ACTIVITY ID","activity_id",.62],["DEPARTMENT","department_name",.78],
      ["GAD MANDATE","gad_mandate",1],["GENDER ISSUE","gender_issue",.95],
      ["CAUSE OF GENDER ISSUE","cause_gender_issue",.95],["GAD RESULT STATEMENT / OBJECTIVE","objectives",.95],
      ["GAD ACTIVITIES TO ATTAIN SUCCESS INDICATORS","gad_activity",1],["PERFORMANCE INDICATORS","performance_indicators",.9],
      ["NEP TARGETS F/M/N/A","nep_targets",.62],["GAD BUDGET (NEP)","budget_nep",.55],
      ["COST BREAKDOWN (NEP)","nep_cost_breakdown",.9],["GAD JUSTIFICATION (NEP)","nep_justification",.8],
      ["REMARKS","variance_remarks",.65],["GAA TARGETS F/M/N/A","gaa_targets",.62],
      ["GAD BUDGET (GAA)","budget_gaa",.55],["COST BREAKDOWN (GAA)","gaa_cost_breakdown",.9],["GAD JUSTIFICATION (GAA)","gaa_justification",.8],
      ["REMARKS ON VARIANCE","variance_remarks",.7],["RESPONSIBLE UNIT","responsible_unit",.7]
    ];
    const weight=cols.reduce((n,c)=>n+c[2],0), widths=cols.map(c=>pageW*c[2]/weight);
    const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
    const cash=v=>"₱"+Number(v||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
    const value=(a,k)=>{
      if(k==="nep_targets")return `F: ${a.targets_female||"—"} / M: ${a.targets_male||"—"} / N/A: ${a.targets_na||"—"}`;
      if(k==="gaa_targets")return `F: ${a.gaa_female||"—"} / M: ${a.gaa_male||"—"} / N/A: ${a.gaa_na||"—"}`;
      if(["budget_nep","budget_gaa","actual_cost"].includes(k))return cash(a[k]);
      return String(a[k]??"—");
    };
    function top(){
      doc.font("Helvetica-Bold").fontSize(13).fillColor(navy).text("ANNUAL GENDER AND DEVELOPMENT (GAD) PLAN AND BUDGET",left,doc.y,{width:pageW,align:"center"});
      doc.font("Helvetica-Bold").fontSize(9).fillColor(ink).text(`CALENDAR YEAR ${year}`,{align:"center"});
      doc.moveDown(.35);
      const y=doc.y, gap=6, w=(pageW-gap*3)/4, h=28;
      const cards=[["NAME OF DOH UNIT","Department of Health - Jose R. Reyes Memorial Medical Center"],["TOTAL GAD BUDGET (NEP)",cash(rows.reduce((n,a)=>n+Number(a.budget_nep||0),0))],["TOTAL GAD BUDGET (GAA)",cash(rows.reduce((n,a)=>n+Number(a.budget_gaa||0),0))],["NUMBER OF ACTIVITIES",String(rows.length)]];
      cards.forEach((c,i)=>{const x=left+i*(w+gap);doc.rect(x,y,w,h).fillAndStroke("#F4F7FA",border);doc.font("Helvetica-Bold").fontSize(5.5).fillColor(navy).text(c[0],x+4,y+4,w-8);doc.font("Helvetica").fontSize(6).fillColor(ink).text(c[1],x+4,y+15,w-8,{height:10,ellipsis:true});});
      doc.y=y+h+8;
    }
    function tableHead(){const y=doc.y,h=30;let x=left;cols.forEach((c,i)=>{doc.rect(x,y,widths[i],h).fillAndStroke(pale,navy);doc.font("Helvetica-Bold").fontSize(5).fillColor(navy).text(c[0],x+2,y+3,widths[i]-4,{height:h-6,align:"center"});x+=widths[i];});doc.y=y+h;}
    function section(label){if(doc.y+50>bottom){doc.addPage({size:"A3",layout:"landscape",margin:22});top();}doc.rect(left,doc.y,pageW,16).fillAndStroke(navy,navy);doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF").text(label,left+5,doc.y+4);doc.y+=16;tableHead();}
    function record(a){const vals=cols.map(c=>value(a,c[1]));const font=5.1;const h=Math.max(25,...vals.map((v,i)=>doc.heightOfString(v,{width:widths[i]-4,fontSize:font})+6));if(doc.y+h>bottom){doc.addPage({size:"A3",layout:"landscape",margin:22});top();doc.font("Helvetica-Bold").fontSize(8).fillColor(navy).text("GAD ACTIVITIES — CONTINUED",left);doc.moveDown(.2);tableHead();}let x=left,y=doc.y;vals.forEach((v,i)=>{doc.rect(x,y,widths[i],h).fillAndStroke("#FFFFFF",border);doc.font("Helvetica").fontSize(font).fillColor(ink).text(v,x+2,y+3,widths[i]-4,{height:h-5,ellipsis:true});x+=widths[i];});doc.y=y+h;}
    top();
    const type=a=>a.activity_type||(a.client_focus_activity?"client_focus_activity":a.attributable_programs?"attributable_programs":"org_focus");
    const groups=[["CLIENT-FOCUSED ACTIVITIES",a=>type(a)==="client_focus_activity"],["ORGANIZATION-FOCUSED ACTIVITIES",a=>type(a)==="org_focus"],["ATTRIBUTABLE ACTIVITIES",a=>type(a)==="attributable_programs"]];
    for(const [label,filter] of groups){section(label);const found=rows.filter(filter);if(!found.length){doc.font("Helvetica-Oblique").fontSize(7).fillColor("#526171").text("No records encoded in this section.",left+4,doc.y+5);doc.y+=18;}else{found.forEach(record);doc.y+=8;}}
    const exportIds=rows.map(a=>a.activity_id);
    const budgetRows=exportIds.length?db.prepare(`SELECT bl.*,a.gad_activity,d.name department_name FROM budget_lines bl JOIN activities a ON a.activity_id=bl.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE bl.activity_id IN (${exportIds.map(()=>"?").join(",")}) ORDER BY a.activity_id,bl.category,bl.id`).all(...exportIds):[];
    const utilizationRows=exportIds.length?db.prepare(`SELECT u.*,a.gad_activity,d.name department_name FROM utilization u JOIN activities a ON a.activity_id=u.activity_id LEFT JOIN departments d ON d.id=a.department_id WHERE u.activity_id IN (${exportIds.map(()=>"?").join(",")}) ORDER BY a.activity_id,u.month,u.category,u.id`).all(...exportIds):[];
    function itemizedPage(title, entries, kind){doc.addPage({size:"A3",layout:"landscape",margin:22});doc.font("Helvetica-Bold").fontSize(13).fillColor(navy).text(title,{align:"center"});doc.moveDown(.5);const headers=kind==="util"?["Activity ID","Responsible Unit","Activity","Month","Category","Item","Patients","Qty","Unit Price / Rate","Amount","Notes"]:kind==="accomp"?["Activity ID","Responsible Unit","GAAD Activity","Status","Actual Results","Actual Cost","Justification / Cost Breakdown"]:["Activity ID","Responsible Unit","Activity","Category","Item","Patients","Qty","Unit Price / Rate","Amount","Notes"];
      const rowsData=entries.map(r=>kind==="util"?[r.activity_id,r.department_name,r.gad_activity,months[r.month-1]||r.month,r.category,r.item,r.patients,r.quantity,cash(r.unit_price||r.rate_per_hour||r.hourly_rate),cash(r.amount),r.notes]:kind==="accomp"?[r.activity_id,r.department_name,r.gad_activity,r.status,r.actual_results,cash(r.actual_cost),[r.actual_justification,r.actual_cost_breakdown,r.actual_variance].filter(Boolean).join(" | ")]:[r.activity_id,r.department_name,r.gad_activity,r.category,r.item,r.patients,r.quantity,cash(r.unit_price||r.rate_per_hour||r.hourly_rate),cash(r.amount),r.notes]);
      const widths=headers.map(()=>pageW/headers.length);let y=doc.y;function head(){let x=left;headers.forEach((h,i)=>{doc.rect(x,y,widths[i],20).fillAndStroke(pale,navy);doc.font("Helvetica-Bold").fontSize(6).fillColor(navy).text(h,x+3,y+5,widths[i]-6,{height:12});x+=widths[i];});y+=20;}
      head();if(!rowsData.length){doc.font("Helvetica").fontSize(8).fillColor(ink).text("No itemized entries.",left,y+6);return;}for(const vals of rowsData){const cells=vals.map(v=>String(v??"—"));const h=Math.max(18,...cells.map((v,i)=>doc.heightOfString(v,{width:widths[i]-6,fontSize:6})+6));if(y+h>bottom){doc.addPage({size:"A3",layout:"landscape",margin:22});y=doc.y;head();}let x=left;cells.forEach((v,i)=>{const cellFill=kind==="accomp"&&i===3?(v==="Finished"?"#E2F7E8":v==="On Process"?"#FFF4CC":"#E5E7EB"):"#FFFFFF";doc.rect(x,y,widths[i],h).fillAndStroke(cellFill,border);doc.font("Helvetica").fontSize(6).fillColor(ink).text(v,x+3,y+3,widths[i]-6,{height:h-5,ellipsis:true});x+=widths[i];});y+=h;}}
    itemizedPage("BUDGET BREAKDOWN",budgetRows,"budget");
    itemizedPage("UTILIZATION BREAKDOWN",utilizationRows,"util");
    const accomplishmentRows=rows.map(a=>({...a,status:accomplishmentStatus(a)}));
    itemizedPage("ACCOMPLISHMENT REPORT",accomplishmentRows,"accomp");
    if(doc.y+60>bottom){doc.addPage({size:"A3",layout:"landscape",margin:22});top();}
    doc.font("Helvetica-Bold").fontSize(8).fillColor(navy).text("PREPARED BY / APPROVED BY");const y=doc.y+25,w=(pageW-70)/2;
    doc.moveTo(left,y).lineTo(left+w,y).stroke(border);doc.moveTo(left+w+70,y).lineTo(left+2*w+70,y).stroke(border);
    doc.font("Helvetica").fontSize(7).fillColor(ink).text("Prepared by: Member of GAD TWG / Focal / Planning Officer",left,y+5,w);
    doc.text("Approved by: Head of Office / Unit / Facility",left+w+70,y+5,w);
    doc.end();
  } catch(e) { console.error(e); res.status(500).json({error:"Unable to generate the PDF export."}); }
});

const frontendDist = path.resolve(__dirname, "../frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(frontendDist, "index.html"), err => { if (err) next(); });
});

app.listen(PORT, () => console.log(`DCES server running on port ${PORT}`));

