const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_FILTER_URL = 'https://open.feishu.cn/open-apis/directory/v1/departments/filter';

const MANAGED_ID_PREFIX = 'od';
const DISABLED_MARK = '[已停用]';

async function getTenantAccessToken(env) {
  const res = await fetch(FEISHU_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu token error: ${JSON.stringify(data)}`);
  return data.tenant_access_token;
}

async function filterChildren(token, parentOpenId) {
  const out = [];
  let pageToken = '';
  while (true) {
    const body = {
      filter: {
        conditions: [
          { field: 'parent_department_id', operator: 'eq', value: JSON.stringify(parentOpenId) },
        ],
      },
      required_fields: ['name', 'parent_department_id', 'department_id', 'enabled_status'],
      page_request: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
    };
    const url = `${FEISHU_FILTER_URL}?department_id_type=open_department_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Feishu filter error: ${JSON.stringify(data)}`);
    const list = data.data?.departments || [];
    out.push(...list);
    const pr = data.data?.page_response || {};
    if (!pr.has_more || !pr.page_token) break;
    pageToken = pr.page_token;
  }
  return out;
}

async function fetchAllDepartments(token) {
  const all = [];
  const seen = new Set();
  const queue = ['0'];
  while (queue.length) {
    const parent = queue.shift();
    const children = await filterChildren(token, parent);
    for (const d of children) {
      const openId = extractOpenId(d);
      if (!openId || seen.has(openId)) continue;
      seen.add(openId);
      all.push({ raw: d, parentOpenId: parent, openId, enabled: d.enabled_status !== false });
      if (d.enabled_status !== false) queue.push(openId);
    }
  }
  return all;
}

function extractOpenId(dept) {
  const id = dept.department_id;
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object') return id.open_department_id || id.department_id || '';
  return dept.open_department_id || '';
}

function extractName(dept) {
  const n = dept.name;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object') {
    return n.default_value || n.zh_cn || n.en || Object.values(n.i18n_value || {})[0] || '';
  }
  return '';
}

function sanitizeId(id) {
  return (id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}

function withDisabledPrefix(name) {
  const s = String(name || '').trim();
  if (s.startsWith(DISABLED_MARK)) return s.slice(0, 40);
  return (DISABLED_MARK + s).slice(0, 40);
}

function mapToZkteco(depts, rootParentNumber) {
  const mapped = [];
  for (const { raw, parentOpenId, openId, enabled } of depts) {
    const deptnumber = sanitizeId(openId);
    let deptname = String(extractName(raw) || '').slice(0, 40);
    if (!enabled) deptname = withDisabledPrefix(deptname);
    const parentnumber =
      parentOpenId === '0' ? rootParentNumber : sanitizeId(parentOpenId);
    if (!deptnumber || !deptname || !parentnumber) continue;
    mapped.push({ deptnumber, deptname, parentnumber });
  }
  return mapped;
}

async function fetchZktecoDepartments(env) {
  const url = `${env.ZKTECO_BASE_URL}/api/v2/department/get/?key=${env.ZKTECO_ACCESS_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`ZKTeco get non-JSON: ${text.slice(0, 200)}`); }
  return data.data?.items || data.items || [];
}

function buildOrphanUpdates(zkList, activeDeptNumbers) {
  const orphans = [];
  for (const d of zkList) {
    const num = d.deptnumber || '';
    if (!num.startsWith(MANAGED_ID_PREFIX)) continue;
    if (activeDeptNumbers.has(num)) continue;
    const currentName = String(d.deptname || '');
    if (currentName.startsWith(DISABLED_MARK)) continue;
    orphans.push({
      deptnumber: num,
      deptname: withDisabledPrefix(currentName),
    });
  }
  return orphans;
}

async function pushToZkteco(env, rows) {
  if (!rows.length) return [];
  const url = `${env.ZKTECO_BASE_URL}/api/v2/department/update/?key=${env.ZKTECO_ACCESS_KEY}`;
  const BATCH = 50;
  const results = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    results.push({ batchStart: i, size: chunk.length, status: res.status, body: parsed });
  }
  return results;
}

async function sync(env) {
  const started = Date.now();
  const token = await getTenantAccessToken(env);
  const feishuDepts = await fetchAllDepartments(token);
  const rootParent = env.ROOT_PARENTNUMBER || '1';
  const activeRows = mapToZkteco(feishuDepts, rootParent);
  const activeNumbers = new Set(activeRows.map(r => r.deptnumber));

  const zkList = await fetchZktecoDepartments(env);
  const orphanRows = buildOrphanUpdates(zkList, activeNumbers);

  const activeResults = await pushToZkteco(env, activeRows);
  const orphanResults = await pushToZkteco(env, orphanRows);

  return {
    feishuCount: feishuDepts.length,
    zktecoCount: zkList.length,
    activePushed: activeRows.length,
    orphanMarked: orphanRows.length,
    totalUpdated:
      activeResults.reduce((s, r) => s + (r.body?.ret === 0 ? (extractUpdatedCount(r.body.msg) ?? r.size) : 0), 0) +
      orphanResults.reduce((s, r) => s + (r.body?.ret === 0 ? (extractUpdatedCount(r.body.msg) ?? r.size) : 0), 0),
    errorBatches:
      activeResults.filter(r => r.status !== 200 || r.body?.ret !== 0).length +
      orphanResults.filter(r => r.status !== 200 || r.body?.ret !== 0).length,
    durationMs: Date.now() - started,
    activeResults,
    orphanResults,
  };
}

function extractUpdatedCount(msg) {
  if (typeof msg !== 'string') return null;
  const m = msg.match(/成功(\d+)条/);
  return m ? Number(m[1]) : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sync') {
      try {
        const result = await sync(env);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }
    if (url.pathname === '/preview') {
      try {
        const token = await getTenantAccessToken(env);
        const depts = await fetchAllDepartments(token);
        const rootParent = env.ROOT_PARENTNUMBER || '1';
        const active = mapToZkteco(depts, rootParent);
        const zkList = await fetchZktecoDepartments(env);
        const orphans = buildOrphanUpdates(zkList, new Set(active.map(r => r.deptnumber)));
        return Response.json({
          activeCount: active.length,
          orphanCount: orphans.length,
          zktecoTotal: zkList.length,
          active,
          orphans,
        });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    return new Response(
      'Feishu → ZKTeco sync worker\n' +
      '  GET /preview  — dry run, show active + orphan updates\n' +
      '  GET /sync     — trigger sync now\n' +
      '  cron: */5 * * * *\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sync(env)
        .then(r => console.log('sync ok', JSON.stringify({
          feishuCount: r.feishuCount, zktecoCount: r.zktecoCount,
          activePushed: r.activePushed, orphanMarked: r.orphanMarked,
          totalUpdated: r.totalUpdated, errorBatches: r.errorBatches,
          durationMs: r.durationMs,
        })))
        .catch(e => console.error('sync failed', e.message, e.stack))
    );
  },
};
