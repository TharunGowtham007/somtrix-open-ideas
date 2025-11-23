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
