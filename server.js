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

// Create ideas table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
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

  // 🔹 NEW: Track who voted, using IP + browser fingerprint
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
// ---------------------------
// Auto-restore from GitHub backups (if DB empty)
// ---------------------------

// Configuration — change only if your repo is different
const GITHUB_OWNER = "TharunGowtham007";
const GITHUB_REPO  = "somtrix-open-ideas";
const GITHUB_BACKUPS_PATH = "backups";
const GITHUB_API_LIST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BACKUPS_PATH}`;

// Helper: sleep for ms
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function autoRestoreIfEmpty() {
  try {
    // 1) Check if ideas table has rows
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

      // Prepare headers for GitHub API requests (use token if available)
      const ghHeaders = { 'Accept': 'application/vnd.github.v3+json' };
      if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

      // 2) List files in backups folder via GitHub API (authenticated if token present)
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

      // 3) Pick the latest backup file by filename (timestamped names sort lexicographically)
      files.sort((a, b) => {
        if (!a.name || !b.name) return 0;
        return a.name < b.name ? 1 : -1; // descending: newest first
      });

      const latest = files[0];
      if (!latest || !latest.download_url) {
        console.log("[autoRestore] No download URL found for latest file:", latest && latest.name);
        return;
      }

      console.log("[autoRestore] Found latest backup:", latest.name);

      // 4) Download the backup file (authenticated if token present)
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

            // 5) Insert items into DB, dedupe by (title + created_at)
      const inserted = [];
      const skipped = [];

      // We'll process items and run direct db.run inserts inside the db.get callbacks.
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
              // small delay to let callbacks finish
              setTimeout(() => {
                console.log(`[autoRestore] Done. inserted=${inserted.length}, skipped=${skipped.length}`);
                if (inserted.length > 0) console.log("[autoRestore] First few inserted:", inserted.slice(0,5));
              }, 200);
            }
            return;
          }

          // Check existence then insert directly with db.run
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

            const votes = Number.isFinite(Number(it.votes)) ? Number(it.votes) : 0;
            db.run(
              "INSERT INTO ideas (author, title, problem, solution_hint, votes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              [it.author || "", title, it.problem || "", it.solution_hint || "", votes, created_at],
              function (insErr) {
                if (insErr) {
                  console.error("[autoRestore] insert error", insErr);
                  skipped.push({ reason: "insert-error", item: it });
                } else {
                  inserted.push({ newId: this.lastID, title });
                }
                if (--pending === 0) {
                  // small delay to let any remaining callbacks finish
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


// Kick off auto-restore (non-blocking)
autoRestoreIfEmpty().catch(err => console.error("[autoRestore] top-level error", err));




// Helpers for sort/search
function buildIdeasQuery(params) {
  const { sort, search } = params;
  let sql = 'SELECT * FROM ideas';
  const sqlParams = [];

  if (search) {
    sql += ' WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ?';
    const like = `%${search.toLowerCase()}%`;
    sqlParams.push(like, like);
  }

  if (sort === 'new') {
    sql += ' ORDER BY datetime(created_at) DESC, votes DESC';
  } else {
    sql += ' ORDER BY votes DESC, datetime(created_at) DESC';
  }

  return { sql, sqlParams };
}

// API routes

// Get ideas
app.get('/api/ideas', (req, res) => {
  const { sql, sqlParams } = buildIdeasQuery(req.query);
  db.all(sql, sqlParams, (err, rows) => {
    if (err) {
      console.error('Error fetching ideas', err);
      return res.status(500).json({ error: 'Failed to fetch ideas' });
    }
    res.json(rows);
  });
});

// Create idea
app.post('/api/ideas', (req, res) => {
  const { author = '', title, problem, solution_hint } = req.body;

  if (!title || !problem || !solution_hint) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const stmt = db.prepare(`
    INSERT INTO ideas (author, title, problem, solution_hint)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    author.trim(),
    title.trim(),
    problem.trim(),
    solution_hint.trim(),
    function (err) {
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
        res.status(201).json(row);
      });
    }
  );

  // 🔹 finalize belongs to the create-idea statement
  stmt.finalize();
});

// Vote for an idea with simple anti-spam (1 vote per IP+browser per idea)
app.post('/api/ideas/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid idea id' });
  }

  // Build a fingerprint from IP + User-Agent
  const ua = req.headers['user-agent'] || '';
  const xff = req.headers['x-forwarded-for'];
  const ip = typeof xff === 'string'
    ? xff.split(',')[0].trim()
    : (req.socket && req.socket.remoteAddress) || '';

  const fingerprint = `${ip}|${ua}`;

  // Try to insert a unique vote record
  db.run(
    'INSERT INTO idea_votes (idea_id, fingerprint) VALUES (?, ?)',
    [id, fingerprint],
    function (err) {
      if (err) {
        // UNIQUE(idea_id, fingerprint) blocked duplicate → already voted
        if (err.code === 'SQLITE_CONSTRAINT') {
          console.log('Duplicate vote blocked for', fingerprint);
          return res.json({ alreadyVoted: true });
        }
        console.error('Error inserting idea_votes row', err);
        return res.status(500).json({ error: 'Failed to support idea' });
      }

      // First time voting from this fingerprint → increment main counter
      db.run(
        'UPDATE ideas SET votes = votes + 1 WHERE id = ?',
        [id],
        function (err2) {
          if (err2) {
            console.error('Error updating votes', err2);
            return res.status(500).json({ error: 'Failed to update votes' });
          }
          if (this.changes === 0) {
            return res.status(404).json({ error: 'Idea not found' });
          }

          db.get('SELECT * FROM ideas WHERE id = ?', [id], (err3, row) => {
            if (err3) {
              console.error('Error fetching updated idea', err3);
              return res.status(500).json({ error: 'Idea updated but failed to reload' });
            }
            res.json(row);
          });
        }
      );
    }
  );
});


// Strong anti-spam voting: one vote per browser token (unique)
app.post("/api/ideas/:id/vote", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid idea id" });
  }

  // Browser token from frontend (preferred)
  let browserToken = req.headers["x-voter-token"];
  if (Array.isArray(browserToken)) browserToken = browserToken[0];

  // Fallback: create fingerprint if no token
  const ua = req.headers["user-agent"] || "";
  const xff = req.headers["x-forwarded-for"];
  const ip = typeof xff === "string"
    ? xff.split(",")[0].trim()
    : (req.socket && req.socket.remoteAddress) || "";

  const fingerprint =
    (typeof browserToken === "string" && browserToken.trim()) ||
    `${ip}|${ua}`;

  // Insert vote record (unique pair: idea_id + fingerprint)
  db.run(
    "INSERT INTO idea_votes (idea_id, fingerprint) VALUES (?, ?)",
    [id, fingerprint],
    function (err) {
      if (err) {
        // UNIQUE constraint = already voted
        if (err.code === "SQLITE_CONSTRAINT") {
          console.log("Blocked duplicate vote:", fingerprint);
          return res.status(200).json({ alreadyVoted: true });
        }

        console.error("Error inserting vote record", err);
        return res.status(500).json({ error: "Failed to support idea" });
      }

      // First time voting → increment idea's vote count
      db.run(
        "UPDATE ideas SET votes = votes + 1 WHERE id = ?",
        [id],
        function (err2) {
          if (err2) {
            console.error("Error updating votes", err2);
            return res.status(500).json({ error: "Failed to update votes" });
          }
          if (this.changes === 0) {
            return res.status(404).json({ error: "Idea not found" });
          }

          // Return updated idea
          db.get("SELECT * FROM ideas WHERE id = ?", [id], (err3, row) => {
            if (err3) {
              console.error("Error loading updated idea", err3);
              return res
                .status(500)
                .json({ error: "Idea updated but could not reload" });
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


app.listen(PORT, () => {
  console.log(`SomTriX ideas board listening on port ${PORT}`);
});
