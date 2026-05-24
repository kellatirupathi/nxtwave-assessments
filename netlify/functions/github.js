/**
 * GitHub proxy function
 *
 * Reads secrets from Netlify env vars (NEVER exposes them to the browser):
 *   GITHUB_TOKEN     — fine-grained PAT with Contents: Read+Write on the repo
 *   GITHUB_OWNER     — your GitHub username (e.g. kellatirupathi)
 *   GITHUB_REPO      — the repo name (e.g. nxtwave-assessments)
 *   ADMIN_PASSWORD   — gate so random visitors can't use this admin tool
 *
 * Browser sends POST with: { password, action, ...args }
 * Actions: ping | list | put | delete
 */

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const ADMIN  = process.env.ADMIN_PASSWORD;
  const TOKEN  = process.env.GITHUB_TOKEN;
  const OWNER  = process.env.GITHUB_OWNER;
  const REPO   = process.env.GITHUB_REPO;

  if (!ADMIN || !TOKEN || !OWNER || !REPO) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'Server not configured. Missing env vars. Check Netlify project settings.' })
    };
  }

  if (body.password !== ADMIN) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid admin password' }) };
  }

  const ghHeaders = {
    'Authorization': 'Bearer ' + TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Netlify-Exam-Admin'
  };

  const repoUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}`;

  try {
    switch (body.action) {

      case 'ping': {
        // Verify token + repo access
        const r = await fetch(repoUrl, { headers: ghHeaders });
        if (!r.ok) throw new Error(`Repo check failed: ${r.status}`);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, owner: OWNER, repo: REPO }) };
      }

      case 'list': {
        // List .html files at repo root
        const r = await fetch(`${repoUrl}/contents/`, { headers: ghHeaders });
        if (!r.ok) throw new Error(`List failed: ${r.status}`);
        const files = await r.json();
        const slim = files
          .filter(f => f.type === 'file' && f.name.endsWith('.html'))
          .map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify(slim) };
      }

      case 'put': {
        const { path, content, message } = body;
        if (!path || typeof content !== 'string') {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'path and content required' }) };
        }

        // Look up existing sha (if file exists) so we can update instead of fail
        let sha = null;
        const probe = await fetch(`${repoUrl}/contents/${encodeURIComponent(path)}`, { headers: ghHeaders });
        if (probe.ok) {
          const ex = await probe.json();
          sha = ex.sha;
        }

        const payload = {
          message: message || (sha ? `Update ${path}` : `Create ${path}`),
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch: 'main'
        };
        if (sha) payload.sha = sha;

        const r = await fetch(`${repoUrl}/contents/${encodeURIComponent(path)}`, {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || `Put failed: ${r.status}`);
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ ok: true, sha: data.content && data.content.sha, commit: data.commit && data.commit.sha })
        };
      }

      case 'delete': {
        const { path } = body;
        if (!path) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'path required' }) };

        // Get sha (required to delete)
        const probe = await fetch(`${repoUrl}/contents/${encodeURIComponent(path)}`, { headers: ghHeaders });
        if (!probe.ok) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'File not found' }) };
        const ex = await probe.json();

        const r = await fetch(`${repoUrl}/contents/${encodeURIComponent(path)}`, {
          method: 'DELETE',
          headers: ghHeaders,
          body: JSON.stringify({ message: `Delete ${path}`, sha: ex.sha, branch: 'main' })
        });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`Delete failed: ${r.status} — ${txt}`);
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + body.action }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
