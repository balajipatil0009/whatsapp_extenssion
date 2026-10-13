const $ = (id) => document.getElementById(id);
const logsEl = $('logs');
const statsEl = $('stats');

function fmtTime(t) {
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLogs(logs) {
  const level = $('levelFilter').value;
  const tag = $('tagFilter').value;
  const q = $('search').value.trim().toLowerCase();

  const filtered = logs.filter((l) => {
    if (level !== 'all' && l.level !== level) return false;
    if (tag !== 'all' && l.tag !== tag) return false;
    if (q && !String(l.message).toLowerCase().includes(q)) return false;
    return true;
  });

  logsEl.innerHTML =
    filtered.length === 0
      ? '<span class="dim">No matching entries.</span>'
      : filtered
          .map((l) => {
            const cls = l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info';
            return `<div class="${cls}"><span class="dim">${fmtTime(l.t)}</span> <span class="tag">[${esc(l.tag)}]</span> ${esc(l.level.toUpperCase())} ${esc(l.message)}</div>`;
          })
          .join('');

  const counts = { error: 0, warn: 0, info: 0 };
  for (const l of logs) counts[l.level] = (counts[l.level] || 0) + 1;
  statsEl.textContent = `${logs.length} total — ${counts.error} errors, ${counts.warn} warnings, ${counts.info} info (${filtered.length} shown)`;
}

function rebuildTagFilter(logs) {
  const sel = $('tagFilter');
  const current = sel.value;
  const tags = Array.from(new Set(logs.map((l) => l.tag))).sort();
  sel.innerHTML =
    '<option value="all">All tags</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if (tags.includes(current)) sel.value = current;
}

async function load() {
  const { logs = [] } = await chrome.storage.local.get({ logs: [] });
  logs.sort((a, b) => a.t - b.t || a.i - b.i);
  rebuildTagFilter(logs);
  renderLogs(logs.map((l) => ({ ...l, _raw: l })));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.logs && $('live').checked) load();
});

$('levelFilter').addEventListener('change', load);
$('tagFilter').addEventListener('change', load);
$('search').addEventListener('input', () => load());
$('refresh').addEventListener('click', () => load());
$('clear').addEventListener('click', async () => {
  if (!confirm('Clear all logs?')) return;
  await chrome.storage.local.set({ logs: [] });
  load();
});
$('copy').addEventListener('click', async () => {
  const text = logsEl.innerText
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/\s+/g, ' '))
    .join('\n');
  const { logs = [] } = await chrome.storage.local.get({ logs: [] });
  const level = $('levelFilter').value;
  const tag = $('tagFilter').value;
  const q = $('search').value.trim().toLowerCase();
  const filtered = logs.filter(
    (l) =>
      (level === 'all' || l.level === level) &&
      (tag === 'all' || l.tag === tag) &&
      (!q || String(l.message).toLowerCase().includes(q))
  );
  await navigator.clipboard.writeText(filtered.map((l) => `${new Date(l.t).toISOString()} [${l.tag}] ${l.level.toUpperCase()} ${l.message}`).join('\n') || text);
});

load();
