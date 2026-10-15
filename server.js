const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const production = process.env.NODE_ENV === "production";
const SQLiteStore = SQLiteStoreFactory(session);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

// Database
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(
  process.env.DB_PATH || path.join(dataDir, "itrenthub.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Equipment',
  description TEXT DEFAULT '',
  daily_rate REAL DEFAULT 0,
  deposit REAL DEFAULT 0,
  image_url TEXT DEFAULT '',
  available INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  customer_note TEXT DEFAULT '',
  staff_note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  staff_note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

const emailOf = value => String(value || "").trim().toLowerCase();

function safeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    role: user.role
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in to continue."
    });
  }

  const user = db.prepare(
    "SELECT id,name,email,phone,role,active FROM users WHERE id=?"
  ).get(req.session.user.id);

  if (!user || !user.active) {
    return res.status(401).json({
      error: "Your account is unavailable. Please log in again."
    });
  }

  req.session.user = safeUser(user);
  next();
}

function requireStaff(req, res, next) {
  if (
    !req.session.user ||
    !["admin", "staff"].includes(req.session.user.role)
  ) {
    return res.status(403).json({
      error: "Admin or staff access required."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({
      error: "Admin access required."
    });
  }

  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// Sessions
if (production && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be configured in Render.");
}

app.use(session({
  name: "itrenthub.sid",
  secret: process.env.SESSION_SECRET || "development-secret-change-this",
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: dataDir
  }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Gmail booking notification
async function sendBookingEmail(booking) {
  const {
    GMAIL_USER,
    GMAIL_APP_PASSWORD,
    ADMIN_EMAIL
  } = process.env;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ADMIN_EMAIL) {
    console.warn(
      "Gmail notification not configured. Check Render environment variables."
    );
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `"ITRentHub" <${GMAIL_USER}>`,
    to: ADMIN_EMAIL,
    subject: `New ITRentHub Booking #${booking.id}`,
    text: `
New booking received!

Booking ID: ${booking.id}
Customer: ${booking.customer_name}
Email: ${booking.customer_email}
Phone: ${booking.customer_phone || "Not provided"}
Equipment: ${booking.product_name}
Start Date: ${booking.start_date}
End Date: ${booking.end_date}
Quantity: ${booking.quantity}
Note: ${booking.customer_note || "None"}
Status: ${booking.status}
`
  });
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ITRentHub"
  });
});

// PUBLIC PRODUCTS — LOGIN NOT REQUIRED
app.get("/api/products", (req, res) => {
  const products = db.prepare(`
    SELECT id,name,category,description,daily_rate,
           deposit,image_url,available
    FROM products
    WHERE available = 1
    ORDER BY id DESC
  `).all();

  res.json({ products });
});

// Register
app.post("/api/register", registerLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = emailOf(req.body.email);
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");

    if (name.length < 2) {
      return res.status(400).json({
        error: "Please enter your full name."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Please enter a valid email."
      });
    }

    if (
      password.length < 10 ||
      !/[A-Za-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return res.status(400).json({
        error: "Password must be at least 10 characters and include a letter and number."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (name,email,phone,password_hash,role)
      VALUES (?,?,?,?,'customer')
    `).run(name, email, phone, hash);

    const user = db.prepare(`
      SELECT id,name,email,phone,role
      FROM users WHERE id=?
    `).get(result.lastInsertRowid);

    req.session.user = safeUser(user);

    res.status(201).json({
      user: req.session.user,
      message: "Account created successfully."
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        error: "This email is already registered."
      });
    }

    console.error(error);

    res.status(500).json({
      error: "Could not create account."
    });
  }
});

// Login
app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const email = emailOf(req.body.email);
    const password = String(req.body.password || "");

    const user = db.prepare(
      "SELECT * FROM users WHERE email=?"
    ).get(email);

    if (
      !user ||
      !user.active ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        error: "Email or password is incorrect."
      });
    }

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Could not start session."
        });
      }

      req.session.user = safeUser(user);

      res.json({
        user: req.session.user,
        message: "Logged in successfully."
      });
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed."
    });
  }
});

// Current user
app.get("/api/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("itrenthub.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: production
    });

    res.json({ message: "Logged out." });
  });
});

// Create booking — LOGIN REQUIRED
app.post("/api/bookings", requireAuth, async (req, res) => {
  try {
    const productId = Number(
      req.body.product_id ?? req.body.productId
    );

    const startDate = String(
      req.body.start_date ?? req.body.startDate ?? ""
    ).trim();

    const endDate = String(
      req.body.end_date ?? req.body.endDate ?? ""
    ).trim();

    const quantity = Number(req.body.quantity || 1);

    const note = String(
      req.body.customer_note ?? req.body.note ?? ""
    ).trim().slice(0, 1000);

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    if (
      !Number.isInteger(productId) ||
      !datePattern.test(startDate) ||
      !datePattern.test(endDate)
    ) {
      return res.status(400).json({
        error: "Choose equipment and valid booking dates."
      });
    }

    if (endDate < startDate) {
      return res.status(400).json({
        error: "End date must be on or after start date."
      });
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({
        error: "Quantity must be between 1 and 100."
      });
    }

    const product = db.prepare(`
      SELECT * FROM products
      WHERE id=? AND available=1
    `).get(productId);

    if (!product) {
      return res.status(404).json({
        error: "Equipment is not available."
      });
    }

    const result = db.prepare(`
      INSERT INTO bookings
      (user_id,product_id,start_date,end_date,quantity,customer_note,status)
      VALUES (?,?,?,?,?,?,'pending')
    `).run(
      req.session.user.id,
      productId,
      startDate,
      endDate,
      quantity,
      note
    );

    const booking = db.prepare(`
      SELECT b.*,
             u.name AS customer_name,
             u.email AS customer_email,
             u.phone AS customer_phone,
             p.name AS product_name
      FROM bookings b
      JOIN users u ON u.id=b.user_id
      JOIN products p ON p.id=b.product_id
      WHERE b.id=?
    `).get(result.lastInsertRowid);

    // Email failure should not cancel the saved booking.
    sendBookingEmail(booking).catch(error => {
      console.error("Booking email failed:", error.message);
    });

    res.status(201).json({
      booking,
      message: "Booking request submitted."
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not submit booking."
    });
  }
});

// Customer bookings
app.get("/api/my/bookings", requireAuth, (req, res) => {
  const bookings = db.prepare(`
    SELECT b.*,p.name AS product_name,
           p.category,p.image_url,p.daily_rate,p.deposit
    FROM bookings b
    JOIN products p ON p.id=b.product_id
    WHERE b.user_id=?
    ORDER BY b.id DESC
  `).all(req.session.user.id);

  res.json({ bookings });
});

// Submit complaint
app.post("/api/complaints", requireAuth, (req, res) => {
  const subject = String(req.body.subject || "").trim().slice(0, 160);
  const message = String(req.body.message || "").trim().slice(0, 3000);

  if (subject.length < 3 || message.length < 5) {
    return res.status(400).json({
      error: "Enter a subject and message."
    });
  }

  const result = db.prepare(`
    INSERT INTO complaints (user_id,subject,message)
    VALUES (?,?,?)
  `).run(req.session.user.id, subject, message);

  res.status(201).json({
    complaint: db.prepare(
      "SELECT * FROM complaints WHERE id=?"
    ).get(result.lastInsertRowid),
    message: "Complaint submitted."
  });
});

// Customer complaints
app.get("/api/my/complaints", requireAuth, (req, res) => {
  const complaints = db.prepare(`
    SELECT * FROM complaints
    WHERE user_id=?
    ORDER BY id DESC
  `).all(req.session.user.id);

  res.json({ complaints });
});

// Admin/staff overview
app.get("/api/manage/overview", requireStaff, (req, res) => {
  const counts = {
    bookings: db.prepare(
      "SELECT COUNT(*) AS n FROM bookings"
    ).get().n,

    pendingBookings: db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE status='pending'"
    ).get().n,

    complaints: db.prepare(
      "SELECT COUNT(*) AS n FROM complaints"
    ).get().n,

    customers: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role='customer'"
    ).get().n,

    products: db.prepare(
      "SELECT COUNT(*) AS n FROM products"
    ).get().n
  };

  const bookings = db.prepare(`
    SELECT b.*,u.name AS customer_name,
           u.email AS customer_email,u.phone AS customer_phone,
           p.name AS product_name
    FROM bookings b
    JOIN users u ON u.id=b.user_id
    JOIN products p ON p.id=b.product_id
    ORDER BY b.id DESC LIMIT 500
  `).all();

  const complaints = db.prepare(`
    SELECT c.*,u.name AS customer_name,u.email AS customer_email
    FROM complaints c
    JOIN users u ON u.id=c.user_id
    ORDER BY c.id DESC LIMIT 500
  `).all();

  const isAdmin = req.session.user.role === "admin";

  const customers = isAdmin
    ? db.prepare(`
        SELECT id,name,email,phone,role,active,created_at
        FROM users WHERE role='customer'
        ORDER BY id DESC
      `).all()
    : [];

  const staff = isAdmin
    ? db.prepare(`
        SELECT id,name,email,phone,role,active,created_at
        FROM users WHERE role IN ('admin','staff')
        ORDER BY id DESC
      `).all()
    : [];

  const products = isAdmin
    ? db.prepare("SELECT * FROM products ORDER BY id DESC").all()
    : [];

  res.json({
    counts,
    bookings,
    complaints,
    customers,
    staff,
    products
  });
});

// Update booking status
app.patch("/api/manage/bookings/:id", requireStaff, (req, res) => {
  const allowed = [
    "pending",
    "approved",
    "rejected",
    "completed",
    "cancelled"
  ];

  const status = String(req.body.status || "").toLowerCase();
  const staffNote = String(
    req.body.staffNote ?? req.body.staff_note ?? ""
  ).trim().slice(0, 1000);

  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: "Invalid booking status."
    });
  }

  const result = db.prepare(`
    UPDATE bookings
    SET status=?,staff_note=?
    WHERE id=?
  `).run(status, staffNote, Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({
      error: "Booking not found."
    });
  }

  res.json({
    booking: db.prepare(
      "SELECT * FROM bookings WHERE id=?"
    ).get(Number(req.params.id)),
    message: "Booking updated."
  });
});

// Update complaint
app.patch("/api/manage/complaints/:id", requireStaff, (req, res) => {
  const status = String(req.body.status || "open").toLowerCase();
  const staffNote = String(
    req.body.staffNote ?? req.body.staff_note ?? ""
  ).trim().slice(0, 1000);

  if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
    return res.status(400).json({
      error: "Invalid complaint status."
    });
  }

  const result = db.prepare(`
    UPDATE complaints
    SET status=?,staff_note=?
    WHERE id=?
  `).run(status, staffNote, Number(req.params.id));

  if (!result.changes) {
    return res.status(404).json({
      error: "Complaint not found."
    });
  }

  res.json({
    complaint: db.prepare(
      "SELECT * FROM complaints WHERE id=?"
    ).get(Number(req.params.id)),
    message: "Complaint updated."
  });
});

// Create staff account — admin only
app.post("/api/manage/staff", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = emailOf(req.body.email);
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");

    if (
      name.length < 2 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: "Enter a valid name and email."
      });
    }

    if (
      password.length < 10 ||
      !/[A-Za-z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      return res.status(400).json({
        error: "Password must be at least 10 characters and include a letter and number."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (name,email,phone,password_hash,role)
      VALUES (?,?,?,?,'staff')
    `).run(name, email, phone, hash);

    res.status(201).json({
      user: safeUser(db.prepare(`
        SELECT id,name,email,phone,role
        FROM users WHERE id=?
      `).get(result.lastInsertRowid))
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        error: "This email is already registered."
      });
    }

    console.error(error);

    res.status(500).json({
      error: "Could not create staff account."
    });
  }
});

// Activate/deactivate user — admin only
app.patch("/api/manage/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (id === req.session.user.id) {
    return res.status(400).json({
      error: "You cannot deactivate your own account."
    });
  }

  const active =
    req.body.active === true ||
    req.body.active === 1 ||
    req.body.active === "1" ||
    req.body.active === "true"
      ? 1 : 0;

  const result = db.prepare(
    "UPDATE users SET active=? WHERE id=?"
  ).run(active, id);

  if (!result.changes) {
    return res.status(404).json({
      error: "User not found."
    });
  }

  res.json({
    message: active ? "User activated." : "User deactivated."
  });
});

// Update product — admin only
app.patch("/api/manage/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare(
    "SELECT * FROM products WHERE id=?"
  ).get(id);

  if (!current) {
    return res.status(404).json({
      error: "Product not found."
    });
  }

  const name = String(req.body.name ?? current.name).trim();
  const category = String(
    req.body.category ?? current.category
  ).trim();

  const description = String(
    req.body.description ?? current.description
  ).trim().slice(0, 2000);

  const dailyRate = Number(
    req.body.daily_rate ?? req.body.dailyRate ?? current.daily_rate
  );

  const deposit = Number(req.body.deposit ?? current.deposit);

  const imageUrl = String(
    req.body.image_url ?? req.body.imageUrl ?? current.image_url
  ).trim().slice(0, 1000);

  const available = req.body.available === undefined
    ? current.available
    : (
        req.body.available === true ||
        req.body.available === 1 ||
        req.body.available === "1" ||
        req.body.available === "true"
      ) ? 1 : 0;

  if (
    !name ||
    !category ||
    !Number.isFinite(dailyRate) ||
    dailyRate < 0 ||
    !Number.isFinite(deposit) ||
    deposit < 0
  ) {
    return res.status(400).json({
      error: "Check product name, category, rate and deposit."
    });
  }

  db.prepare(`
    UPDATE products
    SET name=?,category=?,description=?,daily_rate=?,
        deposit=?,image_url=?,available=?
    WHERE id=?
  `).run(
    name,
    category,
    description,
    dailyRate,
    deposit,
    imageUrl,
    available,
    id
  );

    res.json({
    product: db.prepare(
      "SELECT * FR
