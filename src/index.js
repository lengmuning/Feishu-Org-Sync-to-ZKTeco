const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_FILTER_URL = 'https://open.feishu.cn/open-apis/directory/v1/departments/filter';
const FEISHU_EMPLOYEES_FILTER_URL = 'https://open.feishu.cn/open-apis/directory/v1/employees/filter';
const FEISHU_USERS_BY_DEPT_URL = 'https://open.feishu.cn/open-apis/contact/v3/users/find_by_department';
const FEISHU_COREHR_ID_CONVERT_URL = 'https://open.feishu.cn/open-apis/corehr/v1/common_data/id/convert';
const FEISHU_COREHR_EMPLOYEE_SEARCH_URL = 'https://open.feishu.cn/open-apis/corehr/v2/employees/search';
const FEISHU_COREHR_EMPLOYEE_BATCH_GET_URL = 'https://open.feishu.cn/open-apis/corehr/v2/employees/batch_get';

const EMPLOYEE_REQUIRED_FIELDS = [
  'base_info.employee_id',
  'base_info.name.name',
  'base_info.departments',
  'work_info.job_number',
];

const COREHR_EMPLOYEE_FIELDS = [
  'employment_id',
  'person_id',
  'employee_number',
  'employment_status',
  'personal_info',
  'employment_info',
  'job_data',
  'job_datas',
];

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

// Pull every department matching a filter (with pagination). The `enabled_status`
// field accepts `eq true` which returns ALL enabled depts in one flat list —
// letting us skip BFS entirely (Feishu rejects `in` on parent_department_id).
async function filterAllDepartmentsBy(token, field, value) {
  const out = [];
  let pageToken = '';
  while (true) {
    const body = {
      filter: { conditions: [{ field, operator: 'eq', value }] },
      required_fields: ['name', 'parent_department_id', 'department_id', 'enabled_status'],
      page_request: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    };
    const url = `${FEISHU_FILTER_URL}?department_id_type=open_department_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Feishu departments/filter error: ${JSON.stringify(data)}`);
    out.push(...(data.data?.departments || []));
    const pr = data.data?.page_response || {};
    if (!pr.has_more || !pr.page_token) break;
    pageToken = pr.page_token;
  }
  return out;
}

// Fetch all enabled departments in one pass, then topologically order them
// (parents first) so ZKTeco writes never fail with "parent not exist".
async function fetchAllDepartments(token) {
  const raw = await filterAllDepartmentsBy(token, 'enabled_status', 'true');

  const byOpenId = new Map();
  const parentOf = new Map();
  for (const d of raw) {
    const openId = extractOpenId(d);
    if (!openId) continue;
    byOpenId.set(openId, d);
    parentOf.set(openId, extractIdValue(d.parent_department_id) || '0');
  }

  // Build parent → children adjacency
  const childrenOf = new Map();
  for (const [openId, parent] of parentOf) {
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(openId);
  }

  // BFS from root '0' (parents first order)
  const ordered = [];
  const visited = new Set();
  const queue = [...(childrenOf.get('0') || [])];
  while (queue.length) {
    const openId = queue.shift();
    if (visited.has(openId)) continue;
    visited.add(openId);
    const d = byOpenId.get(openId);
    if (!d) continue;
    ordered.push({
      raw: d,
      parentOpenId: parentOf.get(openId) || '0',
      openId,
      enabled: true,
    });
    queue.push(...(childrenOf.get(openId) || []));
  }

  // Catch any dept whose parent is missing (e.g. parent was disabled but child wasn't).
  // Push them at the end under root so they still land somewhere valid.
  for (const [openId, d] of byOpenId) {
    if (visited.has(openId)) continue;
    ordered.push({
      raw: d,
      parentOpenId: '0',
      openId,
      enabled: true,
    });
  }
  return ordered;
}

function extractOpenId(dept) {
  return extractIdValue(dept.department_id) || extractIdValue(dept.open_department_id);
}

function extractName(dept) {
  return extractText(dept.name);
}

function extractIdValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.open_department_id || value.department_id || value.open_id || value.id || '';
  }
  return '';
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.map(extractText).find(Boolean);
    return first || '';
  }
  if (value && typeof value === 'object') {
    const i18nText = Object.values(value.i18n_value || {}).map(extractText).find(Boolean);
    const candidates = [
      value.default_value,
      value.name,
      value.full_name,
      value.local_name,
      value.display_name,
      value.value,
      value.zh_cn,
      value['zh-CN'],
      value.en,
      value['en-US'],
      i18nText,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return candidate;
      if (candidate && typeof candidate === 'object') {
        const text = extractText(candidate);
        if (text) return text;
      }
    }
  }
  return '';
}

function findFirstStringByKeys(value, keys, depth = 0) {
  if (!value || depth > 8) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    const id = extractIdValue(candidate);
    if (id) return id;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const found = findFirstStringByKeys(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function collectStrings(value, out = [], depth = 0) {
  if (!value || depth > 8) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out, depth + 1);
  }
  return out;
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

// Primary path: Directory v1 employees/filter with `in` operator to batch many depts in one call.
// This collapses N per-dept HTTP calls into ceil(N/50) subrequests, staying under the free-plan
// Worker subrequest cap. Returns employees matching any of the supplied dept open_ids.
async function fetchFeishuEmployeesByDeptsBatch(token, deptOpenIds) {
  const out = [];
  let pageToken = '';
  while (true) {
    const body = {
      filter: {
        conditions: [
          {
            field: 'base_info.departments.department_id',
            operator: 'in',
            value: JSON.stringify(deptOpenIds),
          },
          // Required pair field per Feishu filter-usage docs; `1` = active employees only
          { field: 'work_info.staff_status', operator: 'eq', value: '1' },
        ],
      },
      required_fields: EMPLOYEE_REQUIRED_FIELDS,
      page_request: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    };
    const url = `${FEISHU_EMPLOYEES_FILTER_URL}?department_id_type=open_department_id&employee_id_type=open_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) {
      const err = new Error(`Feishu employees/filter error: ${JSON.stringify(data)}`);
      err.feishuCode = data.code;
      throw err;
    }
    const list = data.data?.employees || [];
    out.push(...list);
    const pr = data.data?.page_response || {};
    if (!pr.has_more || !pr.page_token) break;
    pageToken = pr.page_token;
  }
  return out;
}

// Per-dept query via Directory v1 employees/filter with `eq`.
// Uses scopes we already have. One HTTP call per dept (plus pagination).
async function fetchFeishuEmployeesByDeptEq(token, deptOpenId) {
  const out = [];
  let pageToken = '';
  while (true) {
    const body = {
      filter: {
        conditions: [
          { field: 'base_info.departments.department_id', operator: 'eq', value: JSON.stringify(deptOpenId) },
          { field: 'work_info.staff_status', operator: 'eq', value: '1' },
        ],
      },
      required_fields: EMPLOYEE_REQUIRED_FIELDS,
      page_request: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    };
    const url = `${FEISHU_EMPLOYEES_FILTER_URL}?department_id_type=open_department_id&employee_id_type=open_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Feishu employees/filter eq error (dept=${deptOpenId}): ${JSON.stringify(data)}`);
    const list = data.data?.employees || [];
    out.push(...list);
    const pr = data.data?.page_response || {};
    if (!pr.has_more || !pr.page_token) break;
    pageToken = pr.page_token;
  }
  return out;
}

// Legacy fallback via Contact v3 (requires contact:* scopes). Kept for reference.
async function fetchFeishuEmployeesByDept(token, deptOpenId) {
  const out = [];
  let pageToken = '';
  while (true) {
    const url = new URL(FEISHU_USERS_BY_DEPT_URL);
    url.searchParams.set('department_id_type', 'open_department_id');
    url.searchParams.set('user_id_type', 'open_id');
    url.searchParams.set('department_id', deptOpenId);
    url.searchParams.set('page_size', '50');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`Feishu users/find_by_department error (dept=${deptOpenId}): ${JSON.stringify(data)}`);
    const list = data.data?.items || [];
    out.push(...list.map(item => ({ ...item, _syncDeptOpenId: deptOpenId })));
    if (!data.data?.has_more || !data.data?.page_token) break;
    pageToken = data.data.page_token;
  }
  return out;
}

async function fetchAllFeishuEmployees(token, enabledDepts) {
  const byEmployeeId = new Map();
  const ids = enabledDepts.map(d => d.openId).filter(Boolean);
  if (!ids.length) return [];
  const BATCH = 50;

  // Try batch `in` first; if the first chunk fails, fall back to per-dept for everything.
  let useBatch = true;
  try {
    const firstChunk = ids.slice(0, BATCH);
    const firstList = await fetchFeishuEmployeesByDeptsBatch(token, firstChunk);
    for (const e of firstList) {
      const empId = extractEmployeeKey(e);
      if (!empId || byEmployeeId.has(empId)) continue;
      byEmployeeId.set(empId, e);
    }
    for (let i = BATCH; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const list = await fetchFeishuEmployeesByDeptsBatch(token, chunk);
      for (const e of list) {
        const empId = extractEmployeeKey(e);
        if (!empId || byEmployeeId.has(empId)) continue;
        byEmployeeId.set(empId, e);
      }
    }
  } catch (e) {
    console.warn('batch employees filter failed, falling back to per-dept:', e.message);
    useBatch = false;
    byEmployeeId.clear();
  }

  if (!useBatch) {
    for (const d of enabledDepts) {
      const list = await fetchFeishuEmployeesByDeptEq(token, d.openId);
      for (const emp of list) {
        const empId = extractEmployeeKey(emp);
        if (!empId || byEmployeeId.has(empId)) continue;
        byEmployeeId.set(empId, emp);
      }
    }
  }
  return Array.from(byEmployeeId.values());
}

function extractEmployeeKey(employee) {
  return (
    employee.base_info?.employee_id ||
    employee.employee_id ||
    employee.open_id ||
    employee.user_id ||
    employee.union_id ||
    employee.work_info?.job_number ||
    employee.employee_no ||
    ''
  );
}

function extractEmployeeName(employee) {
  return extractText(
    employee.base_info?.name?.name ||
    employee.base_info?.name ||
    employee.personal_info?.name_list ||
    employee.personal_info?.name ||
    employee.employment_info?.name ||
    employee.name_list ||
    employee.name
  );
}

function extractEmployeeDeptOpenId(employee) {
  if (employee._syncDeptOpenId) return employee._syncDeptOpenId;
  if (Array.isArray(employee.department_ids) && employee.department_ids[0]) return extractIdValue(employee.department_ids[0]);
  const depts = employee.base_info?.departments || [];
  const dept = depts.find(d => d.is_primary || d.is_main) || depts[0];
  return (
    extractIdValue(dept?.department_id) ||
    extractIdValue(dept?.open_department_id) ||
    findFirstStringByKeys(employee, [
      'open_department_id',
      'department_id',
      'main_department_id',
      'primary_department_id',
    ])
  );
}

function mapEmployeeToZktecoRow(employee) {
  const pin = String(
    employee.work_info?.job_number ||
    employee.employee_number ||
    employee.employee_no ||
    employee.employment_info?.employee_number ||
    employee.employment_info?.worker_id ||
    findFirstStringByKeys(employee, ['job_number', 'employee_number', 'employee_no', 'worker_id']) ||
    ''
  ).trim();
  const name = extractEmployeeName(employee).trim();
  const deptnumber = sanitizeId(extractEmployeeDeptOpenId(employee));
  if (!pin) return { skipped: { reason: 'no_job_number', name, employee_id: extractEmployeeKey(employee) } };
  if (!/^[a-zA-Z0-9]{1,24}$/.test(pin)) return { skipped: { reason: 'invalid_pin_format', pin, name } };
  if (!name) return { skipped: { reason: 'no_name', pin } };
  if (!deptnumber) return { skipped: { reason: 'no_department', pin, name } };
  return {
    row: {
      pin,
      name: name.slice(0, 20),
      deptnumber,
    },
  };
}

function mapEmployeesToZkteco(employees) {
  const rows = [];
  const skipped = [];
  for (const e of employees) {
    const mapped = mapEmployeeToZktecoRow(e);
    if (mapped.row) rows.push(mapped.row);
    else skipped.push(mapped.skipped);
  }
  return { rows, skipped };
}

async function pushEmployeesToZkteco(env, rows) {
  if (!rows.length) return [];
  const url = `${env.ZKTECO_BASE_URL}/api/v2/employee/update/?key=${env.ZKTECO_ACCESS_KEY}`;
  const BATCH = 100;
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

async function sync(env, { syncUsers = true } = {}) {
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

  let userResult = null;
  if (syncUsers) {
    try {
      const enabledDepts = feishuDepts.filter(d => d.enabled);
      const employees = await fetchAllFeishuEmployees(token, enabledDepts);
      const { rows: userRows, skipped } = mapEmployeesToZkteco(employees);
      const userPushResults = await pushEmployeesToZkteco(env, userRows);
      userResult = {
        feishuEmployeeCount: employees.length,
        pushedCount: userRows.length,
        skippedCount: skipped.length,
        skippedSample: skipped.slice(0, 20),
        totalUpdated: userPushResults.reduce(
          (s, r) => s + (r.body?.ret === 0 ? (extractUpdatedCount(r.body.msg) ?? r.size) : 0), 0
        ),
        errorBatches: userPushResults.filter(r => r.status !== 200 || r.body?.ret !== 0).length,
        pushResults: userPushResults,
      };
    } catch (e) {
      userResult = { error: e.message };
    }
  }

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
    users: userResult,
  };
}

function extractUpdatedCount(msg) {
  if (typeof msg !== 'string') return null;
  const m = msg.match(/成功(\d+)条/);
  return m ? Number(m[1]) : null;
}

async function handleFeishuWebhook(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.type === 'url_verification') {
    if (env.FEISHU_VERIFICATION_TOKEN && body.token !== env.FEISHU_VERIFICATION_TOKEN) {
      return Response.json({ error: 'invalid token' }, { status: 401 });
    }
    return Response.json({ challenge: body.challenge });
  }

  const headerToken = body.header?.token;
  if (env.FEISHU_VERIFICATION_TOKEN && headerToken !== env.FEISHU_VERIFICATION_TOKEN) {
    return Response.json({ error: 'invalid token' }, { status: 401 });
  }

  const eventType = body.header?.event_type;
  const event = body.event;
  if (!eventType || !event) return Response.json({ ok: true, ignored: true });

  ctx.waitUntil(
    dispatchFeishuEvent(env, eventType, event)
      .then(() => console.log('webhook ok', eventType, body.header?.event_id))
      .catch(e => console.error('webhook err', eventType, e.message, e.stack))
  );
  return Response.json({ ok: true });
}

async function dispatchFeishuEvent(env, eventType, event) {
  const object = event.object || event || {};
  switch (eventType) {
    case 'contact.department.created_v3':
    case 'contact.department.updated_v3':
      return handleDepartmentUpsert(env, object);
    case 'contact.department.deleted_v3':
      return handleDepartmentDelete(env, object);
    case 'contact.user.created_v3':
    case 'contact.user.updated_v3':
      return handleUserUpsert(env, object);
    case 'contact.user.deleted_v3':
      return handleUserDelete(env, object);
    case 'corehr.job_data.employed_v1':
    case 'corehr.job_data.changed_v1':
    case 'corehr.person.updated_v1':
      return handleCoreHrEmployeeUpsert(env, eventType, object);
    case 'corehr.employment.resigned_v1':
      return handleCoreHrEmploymentResigned(eventType, object);
    default:
      console.log('event ignored', eventType);
  }
}

async function handleDepartmentUpsert(env, object) {
  const openId =
    extractIdValue(object.open_department_id) || extractIdValue(object.department_id);
  if (!openId) return;
  const parentOpenId = extractIdValue(object.parent_department_id) || '0';
  const rootParent = env.ROOT_PARENTNUMBER || '1';
  const row = {
    deptnumber: sanitizeId(openId),
    deptname: String(extractText(object.name) || '').slice(0, 40),
    parentnumber: parentOpenId === '0' ? rootParent : sanitizeId(parentOpenId),
  };
  if (!row.deptnumber || !row.deptname || !row.parentnumber) return;
  await pushToZkteco(env, [row]);
}

async function handleDepartmentDelete(env, object) {
  const openId =
    extractIdValue(object.open_department_id) || extractIdValue(object.department_id);
  if (!openId) return;
  const deptnumber = sanitizeId(openId);
  const zkList = await fetchZktecoDepartments(env);
  const current = zkList.find(d => d.deptnumber === deptnumber);
  if (!current) return;
  const currentName = String(current.deptname || '');
  if (currentName.startsWith(DISABLED_MARK)) return;
  await pushToZkteco(env, [{ deptnumber, deptname: withDisabledPrefix(currentName) }]);
}

async function handleUserUpsert(env, object) {
  const pin = String(object.employee_no || '').trim();
  if (!pin) return;
  if (!/^[a-zA-Z0-9]{1,24}$/.test(pin)) return;
  const name = String(extractText(object.name) || '').trim();
  if (!name) return;
  const deptIds = object.department_ids || [];
  const firstDeptId = extractIdValue(deptIds[0]);
  if (!firstDeptId) return;
  const row = {
    pin,
    name: name.slice(0, 20),
    deptnumber: sanitizeId(firstDeptId),
  };
  await pushEmployeesToZkteco(env, [row]);
}

async function handleUserDelete(env, object) {
  console.log('user deleted in feishu (no zkteco delete performed)',
    object.employee_no || extractIdValue(object.open_id));
}

function extractCoreHrEmploymentId(object) {
  return findFirstStringByKeys(object, [
    'employment_id',
    'employmentId',
    'employee_id',
    'employeeId',
    'user_id',
    'userId',
  ]);
}

function extractCoreHrPersonId(object) {
  return findFirstStringByKeys(object, [
    'person_id',
    'personId',
  ]);
}

async function feishuConvertCoreHrEmploymentIdToOpenId(token, employmentId) {
  const url = new URL(FEISHU_COREHR_ID_CONVERT_URL);
  url.searchParams.set('id_transform_type', '1');
  url.searchParams.set('id_type', 'user_id');
  url.searchParams.set('feishu_user_id_type', 'open_id');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids: [employmentId] }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    console.warn('corehr id convert failed', employmentId, JSON.stringify(data).slice(0, 500));
    return '';
  }

  const preferred = findFirstStringByKeys(data.data, [
    'target_id',
    'targetId',
    'open_id',
    'openId',
    'converted_id',
    'convertedId',
  ]);
  if (preferred && preferred !== employmentId) return preferred;

  const strings = collectStrings(data.data);
  return strings.find(s => s !== employmentId && s.startsWith('ou_')) || '';
}

async function feishuFindDirectoryEmployeeByCoreHrId(token, employmentId) {
  const openId = await feishuConvertCoreHrEmploymentIdToOpenId(token, employmentId);
  const attempts = [
    ...(openId ? [{
      employeeIdType: 'open_id',
      field: 'base_info.employee_id',
      value: openId,
    }] : []),
    {
      employeeIdType: 'people_corehr_id',
      field: 'base_info.employee_id',
      value: employmentId,
    },
    {
      employeeIdType: 'open_id',
      field: 'base_info.employee_id',
      value: employmentId,
    },
  ];
  for (const attempt of attempts) {
    const body = {
      filter: {
        conditions: [
          { field: attempt.field, operator: 'eq', value: JSON.stringify(attempt.value) },
          { field: 'work_info.staff_status', operator: 'eq', value: '1' },
        ],
      },
      required_fields: EMPLOYEE_REQUIRED_FIELDS,
      page_request: { page_size: 5 },
    };
    const url = `${FEISHU_EMPLOYEES_FILTER_URL}?department_id_type=open_department_id&employee_id_type=${attempt.employeeIdType}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code === 0 && data.data?.employees?.[0]) return data.data.employees[0];
    if (data.code !== 0) {
      console.warn('directory employee lookup failed',
        attempt.employeeIdType, employmentId, JSON.stringify(data).slice(0, 500));
    }
  }
  return null;
}

async function feishuCoreHrEmployeeSearchByEmploymentId(token, employmentId) {
  const url = new URL(FEISHU_COREHR_EMPLOYEE_SEARCH_URL);
  url.searchParams.set('page_size', '10');
  url.searchParams.set('user_id_type', 'people_corehr_id');
  url.searchParams.set('department_id_type', 'open_department_id');
  const body = {
    fields: COREHR_EMPLOYEE_FIELDS,
    employment_id_list: [employmentId],
    employment_status: 'hired',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu corehr employee/search error: ${JSON.stringify(data)}`);
  const list = data.data?.items || data.data?.employees || data.data?.employee_list || [];
  return list[0] || null;
}

async function feishuCoreHrEmployeeBatchGetByPersonId(token, personId) {
  const url = new URL(FEISHU_COREHR_EMPLOYEE_BATCH_GET_URL);
  url.searchParams.set('user_id_type', 'people_corehr_id');
  url.searchParams.set('department_id_type', 'open_department_id');
  const body = {
    fields: COREHR_EMPLOYEE_FIELDS,
    person_ids: [personId],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu corehr employee/batch_get error: ${JSON.stringify(data)}`);
  const list = data.data?.items || data.data?.employees || data.data?.employee_list || [];
  const hired = list.find(e => {
    const status = String(
      e.employment_status ||
      e.employment_info?.employment_status ||
      findFirstStringByKeys(e, ['employment_status', 'status'])
    ).toLowerCase();
    return !status || status === 'hired' || status === 'active' || status === '1';
  });
  return hired || list[0] || null;
}

async function feishuFindEmployeeFromCoreHrEvent(token, eventType, object) {
  const employmentId = extractCoreHrEmploymentId(object);
  if (employmentId) {
    const directoryEmployee = await feishuFindDirectoryEmployeeByCoreHrId(token, employmentId);
    if (directoryEmployee) return { employee: directoryEmployee, source: 'directory', employmentId };

    const coreHrEmployee = await feishuCoreHrEmployeeSearchByEmploymentId(token, employmentId);
    if (coreHrEmployee) return { employee: coreHrEmployee, source: 'corehr.employee.search', employmentId };
  }

  const personId = extractCoreHrPersonId(object);
  if (personId) {
    const coreHrEmployee = await feishuCoreHrEmployeeBatchGetByPersonId(token, personId);
    if (coreHrEmployee) return { employee: coreHrEmployee, source: 'corehr.employee.batch_get', personId };
  }

  console.warn('corehr event has no resolvable employee',
    eventType,
    JSON.stringify({ employmentId, personId, object }).slice(0, 1000));
  return null;
}

async function handleCoreHrEmployeeUpsert(env, eventType, object) {
  const token = await getTenantAccessToken(env);
  const found = await feishuFindEmployeeFromCoreHrEvent(token, eventType, object);
  if (!found?.employee) return;

  const mapped = mapEmployeeToZktecoRow(found.employee);
  if (!mapped.row) {
    console.warn('corehr employee skipped',
      eventType,
      found.source,
      JSON.stringify(mapped.skipped || {}).slice(0, 500),
      JSON.stringify(found.employee).slice(0, 1000));
    return;
  }

  const result = await pushEmployeesToZkteco(env, [mapped.row]);
  console.log('corehr employee upserted',
    eventType,
    found.source,
    JSON.stringify(mapped.row),
    JSON.stringify(result).slice(0, 1000));
}

async function handleCoreHrEmploymentResigned(eventType, object) {
  console.log('corehr employment resigned (no zkteco delete performed)',
    eventType,
    JSON.stringify({
      employment_id: extractCoreHrEmploymentId(object),
      person_id: extractCoreHrPersonId(object),
    }));
}

async function feishuFindEmployeeByJobNumber(token, jobNumber) {
  const url = 'https://open.feishu.cn/open-apis/directory/v1/employees/filter?department_id_type=open_department_id&employee_id_type=open_id';
  const body = {
    filter: {
      conditions: [
        { field: 'work_info.job_number', operator: 'eq', value: JSON.stringify(jobNumber) },
      ],
    },
    required_fields: [
      'base_info.employee_id',
      'base_info.name.name',
      'base_info.departments',
      'work_info.job_number',
    ],
    page_request: { page_size: 5 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu employees/filter error: ${JSON.stringify(data)}`);
  return data.data?.employees?.[0] || null;
}

async function fetchZktecoEmployeesAll(env) {
  const url = `${env.ZKTECO_BASE_URL}/api/v2/employee/get/?key=${env.ZKTECO_ACCESS_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`ZKTeco employee/get non-JSON: ${text.slice(0, 200)}`); }
  return data.data?.items || data.items || [];
}

async function zktecoFindEmployee(env, pin) {
  const url = `${env.ZKTECO_BASE_URL}/api/v2/employee/get/?key=${env.ZKTECO_ACCESS_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`ZKTeco employee/get non-JSON: ${text.slice(0, 200)}`); }
  const items = data.data?.items || [];
  return items.find(it => it.pin === pin) || null;
}

async function testPerson(env, empno) {
  const token = await getTenantAccessToken(env);
  const feishuEmp = await feishuFindEmployeeByJobNumber(token, empno);
  if (!feishuEmp) throw new Error(`Feishu: employee not found by job_number=${empno}`);

  const feishuDepts = feishuEmp.base_info?.departments || [];
  const firstDept = feishuDepts.find(d => d.is_primary || d.is_main) || feishuDepts[0];
  const feishuDeptOpenId = extractIdValue(firstDept?.department_id) || extractIdValue(firstDept?.open_department_id);
  if (!feishuDeptOpenId) throw new Error(`Feishu: employee has no department`);
  const targetDeptnumber = sanitizeId(feishuDeptOpenId);

  const before = await zktecoFindEmployee(env, empno);
  if (!before) throw new Error(`ZKTeco: employee pin=${empno} not found`);

  const payload = [{ pin: empno, deptnumber: targetDeptnumber }];
  const updateUrl = `${env.ZKTECO_BASE_URL}/api/v2/employee/update/?key=${env.ZKTECO_ACCESS_KEY}`;
  const updRes = await fetch(updateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const updText = await updRes.text();
  let updResult;
  try { updResult = JSON.parse(updText); } catch { updResult = { raw: updText }; }

  const after = await zktecoFindEmployee(env, empno);

  const changed = [];
  const preserved = [];
  if (after && before) {
    for (const k of Object.keys(before)) {
      if (before[k] !== after[k]) changed.push({ field: k, before: before[k], after: after[k] });
      else preserved.push(k);
    }
  }

  return {
    feishu: {
      name: extractEmployeeName(feishuEmp),
      job_number: feishuEmp.work_info?.job_number,
      department_id: feishuDeptOpenId,
      department_name: extractText(firstDept?.name),
      department_path: (firstDept?.department_path_infos || []).map(p => extractText(p.department_name)),
    },
    mapping: {
      feishu_open_id: feishuDeptOpenId,
      target_zkteco_deptnumber: targetDeptnumber,
    },
    sentPayload: payload,
    updateResponse: { status: updRes.status, body: updResult },
    before,
    after,
    diff: { changed, preservedFields: preserved },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/feishu/webhook' && request.method === 'POST') {
      return handleFeishuWebhook(request, env, ctx);
    }
    if (url.pathname === '/test-person') {
      const empno = url.searchParams.get('empno');
      if (!empno) return Response.json({ error: 'missing ?empno=' }, { status: 400 });
      try {
        const result = await testPerson(env, empno);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }
    if (url.pathname === '/sync') {
      try {
        const result = await sync(env, { syncUsers: url.searchParams.get('users') !== '0' });
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }
    if (url.pathname === '/preview') {
      try {
        const includeUsers = url.searchParams.get('users') !== '0';
        const token = await getTenantAccessToken(env);
        const depts = await fetchAllDepartments(token);
        const rootParent = env.ROOT_PARENTNUMBER || '1';
        const active = mapToZkteco(depts, rootParent);
        const zkList = await fetchZktecoDepartments(env);
        const orphans = buildOrphanUpdates(zkList, new Set(active.map(r => r.deptnumber)));
        let users = null;
        if (includeUsers) {
          try {
            const enabledDepts = depts.filter(d => d.enabled);
            const employees = await fetchAllFeishuEmployees(token, enabledDepts);
            const { rows, skipped } = mapEmployeesToZkteco(employees);
            users = {
              feishuEmployeeCount: employees.length,
              rowCount: rows.length,
              skippedCount: skipped.length,
              rowsSample: rows.slice(0, 50),
              skippedSample: skipped.slice(0, 50),
            };
          } catch (e) {
            users = { error: e.message };
          }
        }
        return Response.json({
          activeCount: active.length,
          orphanCount: orphans.length,
          zktecoTotal: zkList.length,
          active,
          orphans,
          users,
        });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    if (url.pathname === '/test-dept-users') {
      try {
        const name = url.searchParams.get('name') || '';
        const openid = url.searchParams.get('openid') || '';
        const dry = url.searchParams.get('dry') === '1';
        if (!name && !openid) {
          return Response.json({ error: 'provide ?name=<dept name> or ?openid=<open_department_id>' }, { status: 400 });
        }
        const token = await getTenantAccessToken(env);
        const depts = await fetchAllDepartments(token);
        const matched = depts.find(d => {
          if (openid && d.openId === openid) return true;
          if (name && extractName(d.raw) === name) return true;
          return false;
        });
        if (!matched) {
          const allNames = depts.map(d => extractName(d.raw)).filter(Boolean);
          return Response.json({
            error: `department not found (name="${name}", openid="${openid}")`,
            hint: 'available sample names below',
            allNamesSample: allNames.slice(0, 50),
          }, { status: 404 });
        }

        // Single-dept employees via Directory v1 filter `eq` (works with our scopes)
        const employees = await fetchFeishuEmployeesByDeptEq(token, matched.openId);
        const { rows, skipped } = mapEmployeesToZkteco(employees);

        // Show ZKTeco "before" for those pins so user can see what will change
        const zkAll = await fetchZktecoEmployeesAll(env);
        const zkByPin = new Map(zkAll.map(e => [String(e.pin), e]));
        const preview = rows.map(r => ({
          pin: r.pin,
          name: r.name,
          target_deptnumber: r.deptnumber,
          existsInZkteco: zkByPin.has(r.pin),
          before: zkByPin.get(r.pin) || null,
        }));

        let pushResults = null;
        let afterSample = null;
        if (!dry) {
          pushResults = await pushEmployeesToZkteco(env, rows);
          // Re-fetch to show after state
          const zkAllAfter = await fetchZktecoEmployeesAll(env);
          const zkByPinAfter = new Map(zkAllAfter.map(e => [String(e.pin), e]));
          afterSample = rows.map(r => ({ pin: r.pin, after: zkByPinAfter.get(r.pin) || null }));
        }

        return Response.json({
          matchedDepartment: {
            name: extractName(matched.raw),
            openId: matched.openId,
            zkteco_deptnumber: sanitizeId(matched.openId),
            enabled: matched.enabled,
          },
          feishuEmployeeCount: employees.length,
          mapped: rows.length,
          skippedCount: skipped.length,
          skipped,
          preview,
          dryRun: dry,
          pushResults,
          afterSample,
        });
      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }
    if (url.pathname === '/sync-users') {
      try {
        const token = await getTenantAccessToken(env);
        const depts = await fetchAllDepartments(token);
        const enabledDepts = depts.filter(d => d.enabled);
        const employees = await fetchAllFeishuEmployees(token, enabledDepts);
        const { rows, skipped } = mapEmployeesToZkteco(employees);
        const pushResults = await pushEmployeesToZkteco(env, rows);
        return Response.json({
          feishuEmployeeCount: employees.length,
          pushedCount: rows.length,
          skippedCount: skipped.length,
          skippedSample: skipped.slice(0, 20),
          totalUpdated: pushResults.reduce(
            (s, r) => s + (r.body?.ret === 0 ? (extractUpdatedCount(r.body.msg) ?? r.size) : 0), 0
          ),
          errorBatches: pushResults.filter(r => r.status !== 200 || r.body?.ret !== 0).length,
          pushResults,
        });
      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
      }
    }
    return new Response(
      'Feishu → ZKTeco sync worker\n' +
      '  POST /feishu/webhook               — Feishu event subscription endpoint (contact + corehr real-time sync)\n' +
      '  GET  /preview                      — dry run, depts + users (add ?users=0 to skip users)\n' +
      '  GET  /sync                         — full sync (depts + users)\n' +
      '  GET  /sync-users                   — sync users only\n' +
      '  GET  /test-person?empno=           — single-employee partial-update diff test\n' +
      '  GET  /test-dept-users?name=…       — test one department’s users (add &dry=1 for preview)\n' +
      '  GET  /test-dept-users?openid=…     — same, by open_department_id\n' +
      '  cron: 0 19 * * *                   — fallback full sync, daily 03:00 Asia/Shanghai (UTC 19:00)\n',
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
          userPushed: r.users?.pushedCount, userUpdated: r.users?.totalUpdated,
          userSkipped: r.users?.skippedCount, userErrorBatches: r.users?.errorBatches,
          durationMs: r.durationMs,
        })))
        .catch(e => console.error('sync failed', e.message, e.stack))
    );
  },
};
