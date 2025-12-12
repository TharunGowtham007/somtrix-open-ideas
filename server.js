// server.js - SomTriX open ideas board (with products, updates, images, comments)
// Saves uploads to ./data/uploads and exposes them at /uploads/*
// Requires: multer, express, sqlite3, fs, path

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const multer = require('multer');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (public)
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data & uploads directories exist
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// SQLite DB
const dbPath = path.join(dataDir, 'ideas.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Failed to connect to SQLite DB', err);
  else console.log('Connected to SQLite DB at', dbPath);
});

// Create existing tables (ideas, idea_votes) and now product-related tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
      email TEXT,
      category TEXT,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      solution_hint TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS idea_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(idea_id, fingerprint)
    )
  `);

  // Products
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      short_desc TEXT,
      long_desc TEXT,
      status TEXT,
      release_date TEXT,
      price TEXT,
      creator TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // product updates (admin posts updates about a product)
  db.run(`
    CREATE TABLE IF NOT EXISTS product_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      images TEXT,  -- stored as JSON array of filenames
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // product images (for product cover/gallery)
  db.run(`
    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // public comments on products
  db.run(`
    CREATE TABLE IF NOT EXISTS product_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      author TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

// ---------------------------
// Multer config for uploads
// ---------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Use timestamp + random + original name for uniqueness
    const safe = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + path.extname(file.originalname);
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 } }); // limit 6MB per file

// ---------------------------
// Keep your existing idea APIs (unchanged)
// ---------------------------

// Helper for building ideas query (search/sort)
function buildIdeasQuery(params) {
  const { sort, search } = params;
  let sql = 'SELECT * FROM ideas';
  const sqlParams = [];

  if (search) {
    sql += ' WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(category) LIKE ?';
    const like = `%${search.toLowerCase()}%`;
    sqlParams.push(like, like, like);
  }

  if (sort === 'new') {
    sql += ' ORDER BY datetime(created_at) DESC, votes DESC';
  } else {
    sql += ' ORDER BY votes DESC, datetime(created_at) DESC';
  }

  return { sql, sqlParams };
}

// Get ideas (public) — hide email
app.get('/api/ideas', (req, res) => {
  const { sql, sqlParams } = buildIdeasQuery(req.query);
  db.all(sql, sqlParams, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch ideas' });
    const publicRows = rows.map(r => {
      const { email, ...rest } = r;
      return rest;
    });
    res.json(publicRows);
  });
});

// Create idea (public)
app.post('/api/ideas', (req, res) => {
  const { author = '', email = '', category = '', title, problem, solution_hint } = req.body;
  if (!title || !problem || !solution_hint) {
    return res.status(400).json({ error: 'Missing required fields (title/problem/solution_hint)' });
  }
  const stmt = db.prepare(`INSERT INTO ideas (author, email, category, title, problem, solution_hint) VALUES (?, ?, ?, ?, ?, ?)`);
  stmt.run(author.trim(), (email || '').trim(), (category || '').trim(), title.trim(), problem.trim(), solution_hint.trim(), function (err) {
    if (err) return res.status(500).json({ error: 'Failed to save idea' });
    db.get('SELECT * FROM ideas WHERE id = ?', [this.lastID], (err2, row) => {
      if (err2) return res.status(500).json({ error: 'Idea created but failed to reload' });
      res.status(201).json(row);
    });
  });
  stmt.finalize();
});

// Vote route (keeps your anti-spam token/IP logic unchanged)
app.post('/api/ideas/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid idea id' });

  let browserToken = req.headers['x-voter-token'];
  if (Array.isArray(browserToken)) browserToken = browserToken[0];

  const ua = req.headers['user-agent'] || '';
  const xff = req.headers['x-forwarded-for'];
  const ip = typeof xff === 'string' ? xff.split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  const fingerprint = (typeof browserToken === 'string' && browserToken.trim()) || `${ip}|${ua}`;

  db.run("INSERT INTO idea_votes (idea_id, fingerprint) VALUES (?, ?)", [id, fingerprint], function (err) {
    if (err) {
      if (err.code === 'SQLITE_CONSTRAINT') return res.status(200).json({ alreadyVoted: true });
      return res.status(500).json({ error: 'Failed to support idea' });
    }
    db.run("UPDATE ideas SET votes = votes + 1 WHERE id = ?", [id], function (err2) {
      if (err2) return res.status(500).json({ error: 'Failed to update votes' });
      if (this.changes === 0) return res.status(404).json({ error: 'Idea not found' });
      db.get("SELECT * FROM ideas WHERE id = ?", [id], (err3, row) => {
        if (err3) return res.status(500).json({ error: 'Idea updated but could not reload' });
        res.json(row);
      });
    });
  });
});

// ==========================
// ADMIN & helpers (ideas)
// ==========================
const ADMIN_KEY = process.env.ADMIN_KEY || "SomTriX-Admin-Key-2025";

function requireAdmin(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: 'Admin access denied' });
  next();
}

// Admin delete idea
function adminDeleteIdeaHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid idea ID' });
  db.run("DELETE FROM ideas WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: 'Error deleting idea' });
    if (this.changes === 0) return res.status(404).json({ error: 'Idea not found' });
    res.json({ success: true, deletedId: id });
  });
}
app.delete("/api/admin/ideas/:id", requireAdmin, adminDeleteIdeaHandler);
app.get("/api/admin/ideas/:id", requireAdmin, adminDeleteIdeaHandler);

// Admin export (ideas)
app.get('/api/admin/export', requireAdmin, (req, res) => {
  db.all('SELECT * FROM ideas ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to export ideas' });
    const filename = `somtrix-ideas-export-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rows, null, 2));
  });
});

// ---------------------------
// PRODUCTS APIs
// ---------------------------

// Public: list products (basic info)
app.get('/api/products', (req, res) => {
  db.all('SELECT id, name, short_desc, status, release_date, price, creator, created_at FROM products ORDER BY datetime(created_at) DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch products' });
    // attach a cover image if available (first product_images row)
    let pending = rows.length;
    if (pending === 0) return res.json([]);
    rows.forEach((r) => {
      db.get('SELECT filename FROM product_images WHERE product_id = ? ORDER BY id ASC LIMIT 1', [r.id], (e, imgRow) => {
        r.cover = imgRow ? `/uploads/${imgRow.filename}` : null;
        if (--pending === 0) return res.json(rows);
      });
    });
  });
});

// Public: product detail with updates, images, comments
app.get('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });

  db.get('SELECT * FROM products WHERE id = ?', [id], (err, product) => {
    if (err || !product) return res.status(404).json({ error: 'Product not found' });

    // fetch images
    db.all('SELECT filename FROM product_images WHERE product_id = ? ORDER BY id ASC', [id], (err2, images) => {
      product.images = images.map(i => `/uploads/${i.filename}`);

      // fetch updates
      db.all('SELECT * FROM product_updates WHERE product_id = ? ORDER BY datetime(created_at) DESC', [id], (err3, updates) => {
        if (!updates) updates = [];
        updates = updates.map(u => {
          try { u.images = JSON.parse(u.images || '[]'); } catch (e) { u.images = []; }
          u.images = (u.images || []).map(f => `/uploads/${f}`);
          return u;
        });
        // fetch comments
        db.all('SELECT * FROM product_comments WHERE product_id = ? ORDER BY datetime(created_at) DESC', [id], (err4, comments) => {
          if (!comments) comments = [];
          product.updates = updates;
          product.comments = comments;
          res.json(product);
        });
      });
    });
  });
});

// Admin: create product (multipart form: images field optional)
app.post('/api/admin/products', requireAdmin, upload.array('images', 8), (req, res) => {
  const { name, short_desc = '', long_desc = '', status = '', release_date = '', price = '', creator = '' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });

  db.run(`INSERT INTO products (name, short_desc, long_desc, status, release_date, price, creator)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name.trim(), short_desc.trim(), long_desc.trim(), status.trim(), (release_date||'').trim(), (price||'').trim(), (creator||'').trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create product' });
      const productId = this.lastID;

      // Save uploaded images to product_images
      const imgs = req.files || [];
      let pending = imgs.length;
      if (pending === 0) {
        return db.get('SELECT * FROM products WHERE id = ?', [productId], (e, p) => res.status(201).json(p));
      }
      imgs.forEach((f) => {
        db.run('INSERT INTO product_images (product_id, filename) VALUES (?, ?)', [productId, f.filename], (ie) => {
          if (ie) console.error('Failed to save product_images row', ie);
          if (--pending === 0) db.get('SELECT * FROM products WHERE id = ?', [productId], (e, p) => res.status(201).json(p));
        });
      });
    }
  );
});

// Admin: create an update for a product (title, body, optional images)
app.post('/api/admin/products/:id/updates', requireAdmin, upload.array('images', 8), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });
  const { title = '', body = '' } = req.body;
  const files = req.files || [];
  const filenames = files.map(f => f.filename);
  db.run('INSERT INTO product_updates (product_id, title, body, images) VALUES (?, ?, ?, ?)', [id, title.trim(), body.trim(), JSON.stringify(filenames)], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to create update' });
    db.get('SELECT * FROM product_updates WHERE id = ?', [this.lastID], (e, row) => {
      if (e) return res.status(500).json({ error: 'Created update but failed to reload' });
      row.images = (row.images ? JSON.parse(row.images) : []).map(f => `/uploads/${f}`);
      res.status(201).json(row);
    });
  });
});

// Admin: list products (full info)
app.get('/api/admin/products', requireAdmin, (req, res) => {
  db.all('SELECT * FROM products ORDER BY datetime(created_at) DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch products' });
    res.json(rows);
  });
});

// Admin: delete product
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });
  db.run('DELETE FROM products WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete product' });
    db.run('DELETE FROM product_images WHERE product_id = ?', [id]);
    db.run('DELETE FROM product_updates WHERE product_id = ?', [id]);
    db.run('DELETE FROM product_comments WHERE product_id = ?', [id]);
    res.json({ success: true, deletedId: id });
  });
});

// Public: post a comment for a product
app.post('/api/products/:id/comments', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { author = '', content } = req.body;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty comment' });
  db.run('INSERT INTO product_comments (product_id, author, content) VALUES (?, ?, ?)', [id, (author||'').trim(), content.trim()], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to save comment' });
    db.get('SELECT * FROM product_comments WHERE id = ?', [this.lastID], (e, row) => {
      if (e) return res.status(500).json({ error: 'Saved comment but failed to reload' });
      res.status(201).json(row);
    });
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve SPA landing (index)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Use PORT env (Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SomTriX ideas board listening on port ${PORT}`);
});
