// server.js - SomTriX open ideas board (uploads enabled, multer) - Nov 2025
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (serve uploads too)
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data + uploads directories exist
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// setup multer storage to public/uploads with safe unique names
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // keep extension, unique prefix
    const ext = path.extname(file.originalname);
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } }); // 8 MB max

// SQLite DB
const dbPath = path.join(dataDir, 'ideas.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Failed to connect to SQLite DB', err);
  else console.log('Connected to SQLite DB at', dbPath);
});

// create tables (ideas, votes, products, updates)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT,
    email TEXT,
    category TEXT,
    title TEXT NOT NULL,
    problem TEXT NOT NULL,
    solution_hint TEXT NOT NULL,
    images TEXT,              -- JSON array of uploaded file paths (relative to /uploads)
    votes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS idea_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(idea_id, fingerprint)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    name TEXT NOT NULL,
    creator TEXT,
    description TEXT,
    images TEXT,       -- JSON array string of image filenames (in /uploads)
    pre_order_link TEXT,
    release_date TEXT,
    price TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS product_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    images TEXT,        -- JSON array string of filenames
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

// helper functions
const ADMIN_KEY = process.env.ADMIN_KEY || "SomTriX-Admin-Key-2025";
function requireAdmin(req, res, next) {
  const key = req.query.admin_key || req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: 'Admin access denied' });
  next();
}
function slugify(text){ return String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,100); }

function buildIdeasQuery(params) {
  const { sort, search } = params || {};
  let sql = 'SELECT * FROM ideas';
  const sqlParams = [];
  if (search) {
    sql += ' WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(category) LIKE ?';
    const like = `%${search.toLowerCase()}%`;
    sqlParams.push(like, like, like);
  }
  if (sort === 'new') sql += ' ORDER BY datetime(created_at) DESC, votes DESC';
  else sql += ' ORDER BY votes DESC, datetime(created_at) DESC';
  return { sql, sqlParams };
}

// PUBLIC: list ideas (hide email)
app.get('/api/ideas', (req, res) => {
  const { sql, sqlParams } = buildIdeasQuery(req.query);
  db.all(sql, sqlParams, (err, rows) => {
    if (err) { console.error('Error fetching ideas', err); return res.status(500).json({ error: 'Failed to fetch ideas' }); }
    // hide email for public
    const publicRows = rows.map(r => {
      const { email, ...rest } = r;
      // parse images into public URLs
      rest.images = (r.images ? JSON.parse(r.images) : []).map(fn => `/uploads/${fn}`);
      return rest;
    });
    res.json(publicRows);
  });
});

// PUBLIC: create idea with optional images (field name: idea_images)
app.post('/api/ideas', upload.array('idea_images', 6), (req, res) => {
  // fields: author,email,category,title,problem,solution_hint
  const { author = '', email = '', category = '', title, problem, solution_hint } = req.body;
  if (!title || !problem || !solution_hint) return res.status(400).json({ error: 'Missing required fields (title/problem/solution_hint)' });

  // uploaded files -> filenames only
  const files = (req.files || []).map(f => path.basename(f.filename || f.path));
  const imagesStr = JSON.stringify(files);

  const stmt = db.prepare(`INSERT INTO ideas (author, email, category, title, problem, solution_hint, images) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  stmt.run((author||'').trim(), (email||'').trim(), (category||'').trim(), title.trim(), problem.trim(), solution_hint.trim(), imagesStr, function(err){
    if (err) { console.error('Error inserting idea', err); return res.status(500).json({ error: 'Failed to save idea' }); }
    db.get('SELECT * FROM ideas WHERE id = ?', [this.lastID], (err2, row) => {
      if (err2) { console.error('Error fetching new idea', err2); return res.status(500).json({ error: 'Idea created but failed to reload' }); }
      row.images = (row.images ? JSON.parse(row.images) : []).map(fn => `/uploads/${fn}`);
      res.status(201).json(row);
    });
  });
  stmt.finalize();
});

// Vote (same fingerprint/token)
app.post('/api/ideas/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid idea id' });
  let browserToken = req.headers['x-voter-token'];
  if (Array.isArray(browserToken)) browserToken = browserToken[0];
  const ua = req.headers['user-agent'] || '';
  const xff = req.headers['x-forwarded-for'];
  const ip = typeof xff === 'string' ? xff.split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  const fingerprint = (typeof browserToken === 'string' && browserToken.trim()) || `${ip}|${ua}`;

  db.run('INSERT INTO idea_votes (idea_id, fingerprint) VALUES (?, ?)', [id, fingerprint], function(err){
    if (err) {
      if (err.code === 'SQLITE_CONSTRAINT') return res.status(200).json({ alreadyVoted: true });
      console.error('Error inserting vote record', err); return res.status(500).json({ error: 'Failed to support idea' });
    }
    db.run('UPDATE ideas SET votes = votes + 1 WHERE id = ?', [id], function(err2){
      if (err2) { console.error('Error updating votes', err2); return res.status(500).json({ error: 'Failed to update votes' }); }
      if (this.changes === 0) return res.status(404).json({ error: 'Idea not found' });
      db.get('SELECT * FROM ideas WHERE id = ?', [id], (err3, row) => {
        if (err3) { console.error('Error loading updated idea', err3); return res.status(500).json({ error: 'Idea updated but could not reload' }); }
        row.images = (row.images ? JSON.parse(row.images) : []).map(fn => `/uploads/${fn}`);
        res.json(row);
      });
    });
  });
});

// ------------------
// PRODUCTS: create/update accept file uploads (field name: product_images[])
// ------------------

// Admin: create product with images (multipart)
app.post('/api/admin/products', requireAdmin, upload.array('product_images', 8), (req, res) => {
  const { name, creator = '', description = '', pre_order_link = '', release_date = '', price = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const images = (req.files || []).map(f => path.basename(f.filename || f.path));
  const imagesStr = JSON.stringify(images);

  const slug = slugify(name);
  db.run(`INSERT INTO products (slug, name, creator, description, images, pre_order_link, release_date, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [slug, name, creator, description, imagesStr, pre_order_link, release_date, price],
    function(err){
      if (err) { console.error('Error inserting product', err); return res.status(500).json({ error: 'Failed to create product' }); }
      db.get('SELECT * FROM products WHERE id = ?', [this.lastID], (err2, row) => {
        if (err2) { console.error('Error fetching new product', err2); return res.status(500).json({ error: 'Created but failed to read back' }); }
        row.images = JSON.parse(row.images || '[]').map(fn => `/uploads/${fn}`);
        res.status(201).json(row);
      });
    }
  );
});

// Admin: update product (allow uploading additional images)
app.put('/api/admin/products/:id', requireAdmin, upload.array('product_images', 8), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });
  const { name, creator = '', description = '', pre_order_link = '', release_date = '', price = '' } = req.body;
  const newFiles = (req.files || []).map(f => path.basename(f.filename || f.path));

  // fetch existing images, append new
  db.get('SELECT images FROM products WHERE id = ?', [id], (err, row) => {
    if (err) { console.error('Error fetching product', err); return res.status(500).json({ error: 'Failed' }); }
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const existing = JSON.parse(row.images || '[]');
    const images = existing.concat(newFiles);
    const imagesStr = JSON.stringify(images);

    const slug = name ? slugify(name) : null;
    db.run(`UPDATE products SET slug = COALESCE(?, slug), name = COALESCE(?, name), creator = ?, description = ?, images = ?, pre_order_link = ?, release_date = ?, price = ? WHERE id = ?`,
      [slug, name, creator, description, imagesStr, pre_order_link, release_date, price, id],
      function(err2){
        if (err2) { console.error('Error updating product', err2); return res.status(500).json({ error: 'Failed to update product' }); }
        db.get('SELECT * FROM products WHERE id = ?', [id], (err3, row2) => {
          if (err3) { console.error('Error fetching product post-update', err3); return res.status(500).json({ error: 'Updated but failed to reload' }); }
          row2.images = JSON.parse(row2.images || '[]').map(fn => `/uploads/${fn}`);
          res.json(row2);
        });
      }
    );
  });
});

// Admin: create update for product with images (field name: update_images[])
app.post('/api/admin/products/:id/updates', requireAdmin, upload.array('update_images', 8), (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const { title, body } = req.body;
  if (!Number.isFinite(productId)) return res.status(400).json({ error: 'Invalid product id' });
  if (!title || !body) return res.status(400).json({ error: 'Missing title or body' });

  const images = (req.files || []).map(f => path.basename(f.filename || f.path));
  const imagesStr = JSON.stringify(images);

  db.run('INSERT INTO product_updates (product_id, title, body, images) VALUES (?, ?, ?, ?)', [productId, title, body, imagesStr], function(err){
    if (err) { console.error('Error inserting product update', err); return res.status(500).json({ error: 'Failed to save update' }); }
    db.get('SELECT * FROM product_updates WHERE id = ?', [this.lastID], (err2, row) => {
      if (err2) { console.error('Error fetching update', err2); return res.status(500).json({ error: 'Saved update but failed to reload' }); }
      row.images = JSON.parse(row.images || '[]').map(fn => `/uploads/${fn}`);
      res.status(201).json(row);
    });
  });
});

// Public: list products
app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY datetime(created_at) DESC', [], (err, rows) => {
    if (err) { console.error('Error fetching products', err); return res.status(500).json({ error: 'Failed to fetch products' }); }
    const parsed = rows.map(r => ({ ...r, images: JSON.parse(r.images || '[]').map(fn => `/uploads/${fn})`.replace(/\)$/, '')) })); // fix below; we'll instead map normally
    // The above one-liner looks odd; use safe mapping:
    const fixed = rows.map(r => ({ ...r, images: (JSON.parse(r.images || '[]') || []).map(fn => `/uploads/${fn}`) }));
    res.json(fixed);
  });
});

// Public: product detail + updates
app.get('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product id' });
  db.get('SELECT * FROM products WHERE id = ?', [id], (err, prod) => {
    if (err) { console.error('Error fetching product', err); return res.status(500).json({ error: 'Failed to fetch product' }); }
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    prod.images = (JSON.parse(prod.images || '[]') || []).map(fn => `/uploads/${fn}`);
    db.all('SELECT * FROM product_updates WHERE product_id = ? ORDER BY datetime(created_at) DESC', [id], (err2, updates) => {
      if (err2) { console.error('Error fetching updates', err2); return res.status(500).json({ error: 'Failed to fetch updates' }); }
      updates = (updates || []).map(u => ({ ...u, images: (JSON.parse(u.images || '[]') || []).map(fn => `/uploads/${fn}`) }));
      res.json({ product: prod, updates });
    });
  });
});

// Admin: list ideas (with email)
app.get('/api/admin/ideas', requireAdmin, (req, res) => {
  const { category } = req.query;
  let sql = 'SELECT * FROM ideas';
  const params = [];
  if (category) { sql += ' WHERE category = ?'; params.push(category); }
  sql += ' ORDER BY datetime(created_at) DESC';
  db.all(sql, params, (err, rows) => {
    if (err) { console.error('Admin ideas fetch failed', err); return res.status(500).json({ error: 'Failed to fetch ideas' }); }
    // attach images URLs
    rows = rows.map(r => ({ ...r, images: (JSON.parse(r.images || '[]') || []).map(fn => `/uploads/${fn}`) }));
    res.json(rows);
  });
});

// Admin: export ideas
app.get('/api/admin/export', requireAdmin, (req, res) => {
  db.all('SELECT * FROM ideas ORDER BY id ASC', [], (err, rows) => {
    if (err) { console.error('Export failed', err); return res.status(500).json({ error: 'Failed to export ideas' }); }
    const filename = `somtrix-ideas-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rows, null, 2));
  });
});

// Admin: delete idea
app.delete("/api/admin/ideas/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid idea ID" });
  db.run("DELETE FROM ideas WHERE id = ?", [id], function (err) {
    if (err) { console.error("Error deleting idea", err); return res.status(500).json({ error: "Error deleting idea" }); }
    if (this.changes === 0) return res.status(404).json({ error: "Idea not found" });
    res.json({ success: true, deletedId: id });
  });
});

// health + landing
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`SomTriX ideas board listening on port ${PORT}`));
