const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "itrenthub.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: dataDir
  }),
  secret: process.env.SESSION_SECRET || "local-development-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT DEFAULT '',
  daily_price REAL NOT NULL DEFAULT 0,
  image_url TEXT DEFAULT '',
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const count = db.prepare(
  "SELECT COUNT(*) AS total FROM products"
).get().total;

if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO products
    (name, category, description, daily_price, image_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  const products = [
    [
      "Business Laptop",
      "Laptops",
      "Laptop for office and business use.",
      650,
      "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=900&q=80"
    ],
    [
      "Desktop Computer",
      "Desktops",
      "Desktop system for daily work.",
      550,
      "https://images.unsplash.com/photo-1587831990711-23ca6441447b?auto=format&fit=crop&w=900&q=80"
    ],
    [
      "MacBook",
      "Laptops",
      "Laptop for creative and professional work.",
      1200,
      "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=900&q=80"
    ],
    [
      "LED Monitor",
      "Monitors",
      "Monitor for your workstation.",
      250,
      "https://images.unsplash.com/photo-1527443224154-c4a3942d3aced?auto=format&fit=crop&w=900&q=80"
    ],
    [
      "Projector",
      "Projectors",
      "Projector for presentations and events.",
      800,
      "https://images.unsplash.com/photo-1585647347384-2593bc35786b?auto=format&fit=crop&w=900&q=80"
    ],
    [
      "Laser Printer",
      "Printers",
      "Printer for office documents.",
      400,
      "https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?auto=format&fit=crop&w=900&q=80"
    ]
  ];

  const seed = db.transaction(rows => {
    rows.forEach(product => insert.run(...product));
  });

  seed(products);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  next();
}

function sendBookingEmail(booking) {
  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  const recipient = process.env.ADMIN_EMAIL || user;

  if (!user || !password || !recipient) {
    console.log("Email settings are not configured.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user,
      pass: password
    }
  });

  transporter.sendMail({
    from: user,
    to: recipient,
    subject: "New ITRentHub booking request",
    text:
      `Booking ID: ${booking.id}\n` +
      `Customer: ${booking.customer}\n` +
      `Email: ${booking.email}\n` +
      `Product: ${booking.product}\n` +
      `Start date: ${booking.start_date}\n` +
      `End date: ${booking.end_date}\n` +
      `Quantity: ${booking.quantity}\n` +
      `Notes: ${booking.notes || "None"}`
  }).catch(error => {
    console.error("Email failed:", error.message);
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "ITRentHub" });
});

/* Public product browsing */
app.get("/api/products", (req, res) => {
  const search = String(req.query.q || "").trim();
  const category = String(req.query.category || "").trim();

  let sql = `
    SELECT id, name, category, description,
           daily_price, image_url, available
    FROM products
    WHERE available = 1
  `;

  const params = [];

  if (category && category !== "All") {
    sql += " AND category = ?";
    params.push(category);
  }

  if (search) {
    sql += " AND (name LIKE ? OR category LIKE ? OR description LIKE ?)";
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  sql += " ORDER BY id DESC";

  res.json({
    products: db.prepare(sql).all(...params)
  });
});

app.get("/api/categories", (req, res) => {
  const categories = db.prepare(`
    SELECT DISTINCT category
    FROM products
    WHERE available = 1
    ORDER BY category
  `).all().map(row => row.category);

  res.json({ categories: ["All", ...categories] });
});

/* Account registration */
app.post("/api/register", limiter, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (
    name.length < 2 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8
  ) {
    return res.status(400).json({
      error: "Enter your name, valid email and password of at least 8 characters."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash)
      VALUES (?, ?, ?)
    `).run(name, email, hash);

    req.session.user = {
      id: Number(result.lastInsertRowid),
      name,
      email,
      role: "customer"
    };

    res.status(201).json({ user: req.session.user });
  } catch (error) {
    res.status(409).json({
      error: "This email may already be registered."
    });
  }
});

/* Login */
app.post("/api/login", limiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const user = db.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).get(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({
      error: "Incorrect email or password."
    });
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({
        error: "Unable to start your session."
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    req.session.save(saveError => {
      if (saveError) {
        return res.status(500).json({
          error: "Unable to save your session."
        });
      }

      res.json({ user: req.session.user });
    });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

/* Booking requires login */
app.post("/api/bookings", requireLogin, (req, res) => {
  const productId = Number(req.body.product_id);
  const start = String(req.body.start_date || "");
  const end = String(req.body.end_date || "");
  const quantity = Number(req.body.quantity || 1);
  const notes = String(req.body.notes || "").trim();

  const product = db.prepare(`
    SELECT * FROM products
    WHERE id = ? AND available = 1
  `).get(productId);

  if (!product) {
    return res.status(404).json({
      error: "Product not found or unavailable."
    });
  }

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (
    !datePattern.test(start) ||
    !datePattern.test(end) ||
    Number.isNaN(Date.parse(start)) ||
    Number.isNaN(Date.parse(end)) ||
    end < start ||
    start < new Date().toISOString().slice(0, 10)
  ) {
    return res.status(400).json({
      error: "Please select valid rental dates."
    });
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return res.status(400).json({
      error: "Quantity must be between 1 and 50."
    });
  }

  const result = db.prepare(`
    INSERT INTO bookings
    (user_id, product_id, start_date, end_date, quantity, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.session.user.id,
    productId,
    start,
    end,
    quantity,
    notes
  );

  const booking = {
    id: Number(result.lastInsertRowid),
    customer: req.session.user.name,
    email: req.session.user.email,
    product: product.name,
    start_date: start,
    end_date: end,
    quantity,
    notes
  };

  sendBookingEmail(booking);

  res.status(201).json({
    booking_id: booking.id,
    message: "Booking request submitted."
  });
});

app.get("/api/bookings/mine", requireLogin, (req, res) => {
  const bookings = db.prepare(`
    SELECT b.id, b.start_date, b.end_date, b.quantity,
           b.notes, b.status, b.created_at,
           p.name AS product_name, p.daily_price
    FROM bookings b
    JOIN products p ON p.id = b.product_id
    WHERE b.user_id = ?
    ORDER BY b.id DESC
  `).all(req.session.user.id);

  res.json({ bookings });
});

/* Website files */
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ITRentHub running on port ${PORT}`);
});
