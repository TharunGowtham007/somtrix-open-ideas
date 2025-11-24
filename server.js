// server.js - SomTriX open ideas board (updated Feb/Nov 2025)
// - Adds support for email & category
// - Safe migration for existing DBs (no Render shell required)
// - Admin JSON endpoint for admin UI (includes email)
// - Auto-restore from GitHub backups (uses backups/ folder in repo)

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// SQLite DB
const dbPath = path.join(dataDir, 'ideas.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite DB', err);
  } else {
    console.log('Connected to SQLite DB at', dbPath);
  }
});

// Create ideas table and votes table (include email & category in schema)
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
  `, (err) => {
    if (err) {
      console.error('Failed to create ideas table', err);
    } else {
      console.log('Ideas table is ready');
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS idea_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(idea_id, fingerprint)
    )
  `, (err) => {
    if (err) {
      console.error('Failed to create idea_votes table', err);
    } else {
      console.log('idea_votes table is ready');
    }
  });
});

// ======================
// Migration helper: add column if missing (safe, idempotent)
// ======================
function ensureColumn(table, column, definition, cb) {
  db.all(`PRAGMA table_info(${table})`, (err, cols) => {
    if (err) {
      console.error(`[migrate] failed to read table info for ${table}`, err);
      return cb && cb(err);
    }
    const found = Array.isArray(cols) && cols.some(c => String(c.name).toLowerCase() === String(column).toLowerCase());
    if (found) {
      return cb && cb();
    }
    // Add column
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
      if (alterErr) {
        console.error(`[migrate] failed to add column ${column} to ${table}`, alterErr);
        return cb && cb(alterErr);
      }
      console.log(`[migrate] added column ${column} to ${table}`);
      cb && cb();
    });
  });
}

// Ensure email & category exist for older DBs (safe)
ensureColumn('ideas', 'email', 'TEXT', () => {});
ensureColumn('ideas', 'category', 'TEXT', () => {});

// ---------------------------
// Auto-restore from GitHub backups (if DB empty)
// ---------------------------

const GITHUB_OWNER = "TharunGowtham007";
const GITHUB_REPO  = "somtrix-open-ideas";
const GITHUB_BACKUPS_PATH = "backups";
const GITHUB_API_LIST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BACKUPS_PATH}`;

// Kick off async auto-restore: fetch latest backups file and insert rows if DB empty
async function autoRestoreIfEmpty() {
  try {
    db.get("SELECT COUNT(*) AS cnt FROM ideas", async (err, row) => {
      if (err) {
        console.error("[autoRestore] failed to check ideas count:", err);
        return;
      }
      const count = (row && row.cnt) ? row.cnt : 0;
      console.log(`[autoRestore] ideas count = ${count}`);
      if (count > 0) {
        console.log("[autoRestore] DB already has ideas — skipping restore.");
        return;
      }

      console.log("[autoRestore] DB empty — attempting to fetch latest backup from GitHub.");

      const ghHeaders = { 'Accept': 'application/vnd.github.v3+json' };
      if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

      let listRes;
      try {
        listRes = await fetch(GITHUB_API_LIST_URL, { headers: ghHeaders });
      } catch (fetchErr) {
        console.error("[autoRestore] Failed to fetch GitHub contents:", fetchErr);
        return;
      }

      if (!listRes.ok) {
        console.error("[autoRestore] GitHub contents API returned non-ok:", listRes.status, await listRes.text().catch(()=>"(no body)"));
        return;
      }

      const files = await listRes.json();
      if (!Array.isArray(files) || files.length === 0) {
        console.log("[autoRestore] No backup files found in backups/ folder.");
        return;
      }

      // newest first
      files.sort((a, b) => {
        if (!a.name || !b.name) return 0;
        return a.name < b.name ? 1 : -1;
      });

      const latest = files[0];
      if (!latest || !latest.download_url) {
        console.log("[autoRestore] No download URL found for latest file:", latest && latest.name);
        return;
      }

      console.log("[autoRestore] Found latest backup:", latest.name);

      let fileRes;
      try {
        fileRes = await fetch(latest.download_url, { headers: ghHeaders });
      } catch (err2) {
        console.error("[autoRestore] Failed to download backup file:", err2);
        return;
      }

      if (!fileRes.ok) {
        console.error("[autoRestore] Backup file download failed:", fileRes.status);
        return;
      }

      const text = await fileRes.text();
      let items;
      try {
        items = JSON.parse(text);
      } catch (parseErr) {
        console.error("[autoRestore] Failed to parse JSON from backup file:", parseErr);
        return;
      }

      if (!Array.isArray(items) || items.length === 0) {
        console.log("[autoRestore] Backup JSON empty or invalid.");
        return;
      }

      console.log(`[autoRestore] Restoring ${items.length} ideas into DB (deduping by title + created_at).`);

      const inserted = [];
      const skipped = [];

      db.serialize(() => {
        let pending = items.length;
        if (pending === 0) {
          console.log("[autoRestore] No items to restore.");
          return;
        }

        items.forEach((it) => {
          const title = (it.title || "").trim();
          const created_at = it.created_at || new Date().toISOString();

          if (!title) {
            skipped.push({ reason: "no-title", item: it });
            if (--pending === 0) {
              setTimeout(() => {
                console.log(`[autoRestore] Done. inserted=${inserted.length}, skipped=${skipped.length}`);
                if (inserted.length > 0) console.log("[autoRestore] First few inserted:", inserted.slice(0,5));
              }, 200);
            }
            return;
          }

          db.get("SELECT id FROM ideas WHERE title = ? AND created_at = ?", [title, created_at], (checkErr, rowExists) => {
            if (checkErr) {
              console.error("[autoRestore] lookup error", checkErr);
              skipped.push({ reason: "lookup-error", item: it });
              if (--pending === 0) {
                setTimeout(() => console.log(`[autoRestore] Done. inserted=${inserted.length}, skipped=${skipped.length}`), 200);
              }
              return;
            }
            if (rowExists) {
              skipped.push({ reason: "exists", item: it });
              if (--pending === 0) {
                setTimeout(() => console.log(`[autoRestore] Done. inserted=${inserted.length}, skipped=${skipped.length}`), 200);
              }
              return;
            }

            // read email & category if present in backup JSON
            const author = it.author || "";
            const email = it.email || "";
            const category = it.category || "";
            const votes = Number.isFinite(Number(it.votes)) ? Number(it.votes) : 0;
            const problem = it.problem || "";
            const solution_hint = it.solution_hint || "";

            db.run(
              "INSERT INTO ideas (author, email, category, title, problem, solution_hint, votes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [author, email, category, title, problem, solution_hint, votes, created_at],
              function (insErr) {
                if (insErr) {
                  console.error("[autoRestore] insert error", insErr);
                  skipped.push({ reason: "insert-error", item: it });
                } else {
                  inserted.push({ newId: this.lastID, title });
                }
                if (--pending === 0) {
                  setTimeout(() => {
                    console.log(`[autoRestore] Done. inserted=${inserted.length}, skipped=${skipped.length}`);
                    if (inserted.length > 0) console.log("[autoRestore] First few inserted:", inserted.slice(0,5));
                  }, 200);
                }
              }
            );
          });
        });
      });

    });
  } catch (e) {
    console.error("[autoRestore] Unexpected error:", e);
  }
}

autoRestoreIfEmpty().catch(err => console.error("[autoRestore] top-level error", err));

// ---------------------------
// Helpers for sort/search
// ---------------------------
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

// API routes

// Get ideas (public) - does not include email for privacy
app.get('/api/ideas', (req, res) => {
  const { sql, sqlParams } = buildIdeasQuery(req.query);
  db.all(sql, sqlParams, (err, rows) => {
    if (err) {
      console.error('Error fetching ideas', err);
      return res.status(500).json({ error: 'Failed to fetch ideas' });
    }
    // remove email field from public response for privacy
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

  const a = author.trim();
  const e = (email || '').trim();
  const cat = (category || '').trim();
  const t = title.trim();
  const p = problem.trim();
  const s = solution_hint.trim();

  const stmt = db.prepare(`
    INSERT INTO ideas (author, email, category, title, problem, solution_hint)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(a, e, cat, t, p, s, function (err) {
    if (err) {
      console.error('Error inserting idea', err);
      return res.status(500).json({ error: 'Failed to save idea' });
    }

    const id = this.lastID;
    db.get('SELECT * FROM ideas WHERE id = ?', [id], (err2, row) => {
      if (err2) {
        console.error('Error fetching new idea', err2);
        return res.status(500).json({ error: 'Idea created but failed to reload' });
      }
      // do not expose email in response unless admin; we return full row to requester (but public UI won't show email)
      res.status(201).json(row);
    });
  });

  stmt.finalize();
});

// Vote for an idea with simple anti-spam (1 vote per token/IP+UA per idea)
app.post('/api/ideas/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid idea id' });
  }

  // Browser token from frontend (preferred)
  let browserToken = req.headers['x-voter-token'];
  if (Array.isArray(browserToken)) browserToken = browserToken[0];

  // Fallback: create fingerprint from IP + UA
  const ua = req.headers['user-agent'] || '';
  const xff = req.headers['x-forwarded-for'];
  const ip = typeof xff === 'string'
    ? xff.split(',')[0].trim()
    : (req.socket && req.socket.remoteAddress) || '';

  const fingerprint = (typeof browserToken === 'string' && browserToken.trim()) || `${ip}|${ua}`;

  db.run(
    "INSERT INTO idea_votes (idea_id, fingerprint) VALUES (?, ?)",
    [id, fingerprint],
    function (err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
          console.log('Blocked duplicate vote:', fingerprint);
          return res.status(200).json({ alreadyVoted: true });
        }
        console.error('Error inserting vote record', err);
        return res.status(500).json({ error: 'Failed to support idea' });
      }

      db.run(
        "UPDATE ideas SET votes = votes + 1 WHERE id = ?",
        [id],
        function (err2) {
          if (err2) {
            console.error('Error updating votes', err2);
            return res.status(500).json({ error: 'Failed to update votes' });
          }
          if (this.changes === 0) {
            return res.status(404).json({ error: 'Idea not found' });
          }
          db.get("SELECT * FROM ideas WHERE id = ?", [id], (err3, row) => {
            if (err3) {
              console.error('Error loading updated idea', err3);
              return res.status(500).json({ error: 'Idea updated but could not reload' });
            }
            res.json(row);
          });
        }
      );
    }
  );
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Use PORT environment variable for Render
const PORT = process.env.PORT || 3000;

// ==========================
// ADMIN ACCESS
// ==========================
const ADMIN_KEY = process.env.ADMIN_KEY || "SomTriX-Admin-Key-2025";

// Middleware to check admin key
function requireAdmin(req, res, next) {
  const key = req.query.admin_key || req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Admin access denied" });
  }
  next();
}

// Admin JSON listing (includes email & category) — protected by requireAdmin
app.get('/api/admin/ideas', requireAdmin, (req, res) => {
  const { category } = req.query;
  let sql = 'SELECT * FROM ideas';
  const params = [];
  if (category) {
    sql += ' WHERE category = ?';
    params.push(category);
  }
  sql += ' ORDER BY datetime(created_at) DESC';
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Admin ideas fetch failed', err);
      return res.status(500).json({ error: 'Failed to fetch ideas' });
    }
    res.json(rows);
  });
});

// Shared handler for deleting an idea by ID (for GET + DELETE)
function adminDeleteIdeaHandler(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid idea ID" });
  }

  db.run("DELETE FROM ideas WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("Error deleting idea", err);
      return res.status(500).json({ error: "Error deleting idea" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Idea not found" });
    }
    res.json({ success: true, deletedId: id });
  });
}

// Allow DELETE (for tools) and GET (for browser) to delete ideas
app.delete("/api/admin/ideas/:id", requireAdmin, adminDeleteIdeaHandler);
app.get("/api/admin/ideas/:id", requireAdmin, adminDeleteIdeaHandler);

// Simple admin export (downloadable) - helpful for backups
app.get('/api/admin/export', requireAdmin, (req, res) => {
  db.all('SELECT * FROM ideas ORDER BY id ASC', [], (err, rows) => {
    if (err) {
      console.error('Export failed', err);
      return res.status(500).json({ error: 'Failed to export ideas' });
    }
    const filename = `somtrix-ideas-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rows, null, 2));
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`SomTriX ideas board listening on port ${PORT}`);
});
