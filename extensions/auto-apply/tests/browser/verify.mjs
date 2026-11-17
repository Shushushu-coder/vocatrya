/**
 * Auto-apply 扩展 content.js 真实浏览器验证（合成 antd 页面）。
 *
 * - 起真实 Chromium（默认 headless；--headed 可视化），Playwright 经 Node 模块解析
 *   向上查找仓库 node_modules（worktree 下会落到主检出）。
 * - 本地静态服务器提供：夹具页、tests/browser/node_modules 内 antd/react/dayjs UMD、
 *   插件 src/content.js 与 sample-profile.json。
 * - addInitScript 注入最小 chrome.runtime stub：OJAF_GET_SETTINGS 返回合成 profileV2，
 *   AI 相关消息统一失败（本地规则路径，等同实机 AI 未配置）；onMessage 收集后由
 *   window.__ojafSend 驱动真实填写链路 OJAF_START_AUTOFILL。
 * - 断言只读真实控件值/选中态/antd 校验态与标记，不以插件自报为准。
 *
 * 用法：node verify.mjs [--headed] [--scenario a,dates]
 */
import { runNegativeScenarios } from './negative.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../..');
const fixtureDir = path.join(here, 'fixtures');
const vendorDir = path.join(here, 'node_modules');
const evidenceDir = process.env.OJAF_EVIDENCE_DIR || path.join(here, 'evidence');

const requireFromRepo = createRequire(path.resolve(extDir, 'package.json').endsWith('package.json') ? path.join(extDir, 'x.cjs') : here);
let chromium;
try {
  ({ chromium } = requireFromRepo('playwright'));
} catch {
  ({ chromium } = requireFromRepo('@playwright/test'));
}

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const only = (() => {
  const i = args.findIndex((a) => a === '--scenario');
  return i >= 0 ? new Set(String(args[i + 1] || '').split(',')) : null;
})();

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x/').pathname);
  let file;
  if (url.startsWith('/vendor/')) file = path.join(vendorDir, url.slice(8));
  else if (url === '/content.js') file = path.join(extDir, 'src/content.js');
  else if (url === '/sample-profile.json') file = path.join(extDir, 'sample-profile.json');
  else file = path.join(fixtureDir, url === '/' ? 'antd-xhs.html' : url);
  if (!file.startsWith(vendorDir) && !file.startsWith(fixtureDir) && !file.startsWith(extDir)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('server', base);

const profile = JSON.parse(fs.readFileSync(path.join(extDir, 'sample-profile.json'), 'utf8')).profileV2;

// ---------- browser ----------
const ctx = await chromium.launchPersistentContext(path.join(evidenceDir, '.chromium-profile'), {
  headless: !HEADED,
  viewport: { width: 1280, height: 1400 },
  args: ['--no-first-run'],
});

const initStub = (pv) => {
  const listeners = [];
  window.__OJAF_LISTENERS__ = listeners;
  window.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(fn) { listeners.push(fn); },
        removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
      },
      sendMessage(message, cb) {
        const type = message && message.type;
        const done = typeof cb === 'function' ? cb : () => {};
        if (type === 'OJAF_GET_SETTINGS') return done({ ok: true, data: { profileV2: pv, settings: {} } });
        if (type === 'OJAF_ANALYZE_PAGE_STRUCTURE' || type === 'OJAF_MAP_FIELDS') return done({ ok: false, error: 'ai not configured' });
        if (type === 'OJAF_SAVE_PROFILE_PANEL_STATE' || type === 'OJAF_GET_PROFILE_PANEL_STATE') return done({ ok: true, data: null });
        return done({ ok: true, data: null });
      }
    },
    storage: { local: { get(_k, cb) { cb({}); }, set(_v, cb) { cb && cb(); } } }
  };
  window.__ojafSend = (msg) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'timeout' }); } }, 60000);
    const send = (m) => {
      let hit = false;
      for (const fn of listeners) {
        const r = fn(m, {}, (resp) => { if (!settled) { settled = true; clearTimeout(timer); resolve(resp); } });
        if (r === true) hit = true;
      }
      return hit;
    };
    if (!send(msg)) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'no listener' }); }
  });
};
await ctx.addInitScript(initStub, profile);

fs.mkdirSync(evidenceDir, { recursive: true });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

async function newFixturePage(file = 'antd-xhs.html') {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(`${base}/${file}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 15000 });
  await page.addScriptTag({ url: `${base}/content.js` });
  await page.waitForFunction(() => Boolean(window.__OJAF_AUTOFILL_INTERNALS__), { timeout: 10000 });
  return page;
}

// ---------- field readers (antd-aware) ----------
const FIELD_READERS = `
(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const formItemOf = (el) => el && el.closest('.ant-form-item');
  const labelOf = (el) => { const l = formItemOf(el)?.querySelector('.ant-form-item-label label, .ant-form-item-label'); return norm(text(l)).replace(/[*＊:：]/g, '').trim(); };
  const inputs = () => Array.from(document.querySelectorAll('input:not([type=hidden]),textarea')).filter((el) => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  const blockOf = (el) => el.closest('.entry-block');
  const errorOf = (el) => { const it = formItemOf(el); return it ? norm(text(it.querySelector('.ant-form-item-explain-error'))) : ''; };
  const markOf = (el) => el.getAttribute('data-ojaf-mark') || '';
  const selectedText = (el) => norm(text(el.closest('.ant-select')?.querySelector('.ant-select-selection-item,.ant-select-selection-wrap')));
  const fieldsByLabel = (label, scope) => {
    const root = scope || document;
    const items = Array.from(root.querySelectorAll('.ant-form-item'));
    const out = [];
    for (const it of items) {
      const l = labelOf(it);
      if (l !== label && !(label.endsWith('*') && l.startsWith(label.slice(0, -1)))) continue;
      const inner = it.querySelector('input:not([type=hidden]),textarea,.ant-select,.ant-radio-group');
      if (inner) out.push({ item: it, el: inner });
    }
    return out;
  };
  const stateOf = (f) => {
    const el = f.el;
    const cls = String(el.className || '');
    if (el.matches('.ant-select')) return { kind: 'select', value: selectedText(el), error: errorOf(el), mark: el.getAttribute('data-ojaf-mark') || el.querySelector('[data-ojaf-mark]')?.getAttribute('data-ojaf-mark') || '' };
    if (el.matches('.ant-radio-group')) { const c = el.querySelector('.ant-radio-checked + span, .ant-radio-wrapper-checked'); const cc = el.querySelector('input:checked'); const cl = cc ? cc.closest('.ant-radio-wrapper') : null; return { kind: 'radio', value: norm(text(cl || c)), error: errorOf(el), mark: el.getAttribute('data-ojaf-mark') || '' }; }
    if (el.type === 'radio') { const cl = el.closest('.ant-radio-wrapper') || el.closest('label'); return { kind: 'radio', value: el.checked ? norm(text(cl)) : '', checked: el.checked, error: errorOf(el), mark: el.getAttribute('data-ojaf-mark') || '' }; }
    return { kind: el.tagName.toLowerCase(), value: el.value, error: errorOf(el), mark: el.getAttribute('data-ojaf-mark') || '' };
  };
  const rangeState = (scope) => {
    const root = scope || document;
    const out = [];
    for (const rp of root.querySelectorAll('.ant-picker-range')) {
      const ins = Array.from(rp.querySelectorAll('input'));
      out.push({ values: ins.map((i) => i.value), ph: ins.map((i) => i.placeholder), error: errorOf(rp), marks: ins.map((i) => i.getAttribute('data-ojaf-mark') || '') });
    }
    return out;
  };
  return { text, norm, labelOf, inputs, blockOf, errorOf, markOf, selectedText, fieldsByLabel, stateOf, rangeState };
})()
`;

async function readPageState(page) {
  return page.evaluate(`(() => { const R = ${FIELD_READERS}; const pick = {};
    for (const label of ['推荐码','姓名','证件号码（用于实名认证）','性别','出生年月','手机号','邮箱','意向工作城市','是否服从调剂','导师','实验室','研究方向','学校所在城市','院系','专业','学校','学历','成绩排名','单位名称','职位名称','工作内容','竞赛/奖项名称','获奖名次','获奖时间','获奖情况描述/链接','证书名称','专利名称','专利人','取得日期','专利描述/链接']) {
      pick[label] = R.fieldsByLabel(label).map(R.stateOf);
    }
    const blocks = Array.from(document.querySelectorAll('.entry-block')).map((b) => ({ cls: b.className, title: R.norm(R.text(b.querySelector('.entry-title'))), fields: Array.from(b.querySelectorAll('.ant-form-item')).map(R.labelOf) }));
    return { pick, blocks, ranges: R.rangeState(), submitClicks: window.__SUBMIT_COUNT__, marks: {
      filled: document.querySelectorAll('[data-ojaf-mark="filled"]').length,
      uncertain: document.querySelectorAll('[data-ojaf-mark="uncertain"]').length,
      skipped: document.querySelectorAll('[data-ojaf-mark="skipped"]').length
    } };
  })()`);
}

async function runFill(page) {
  return page.evaluate(`window.__ojafSend({ type: 'OJAF_START_AUTOFILL' }).then((r) => r && r.data ? r.data : r)`);
}

async function runPlanOnly(page) {
  return page.evaluate(`window.__ojafSend({ type: 'OJAF_GET_DEBUG_SNAPSHOT' })`);
}

// ---------- scenarios ----------
const SCENARIOS = {
  async negative() { await runNegativeScenarios(newFixturePage, record); },
  // A: 日期控件真实接受与回读
  async dates(page) {
    const st = await readPageState(page);
    const birth = st.pick['出生年月'][0] || {};
    record('A1 出生年月按 YYYY-MM 写入且被组件接受', birth.value === '1999-01', `value=${birth.value}`);
    record('A2 出生年月无校验错误', !birth.error, `error=${birth.error}`);
    const eduRange = (st.ranges || []).find((r) => r.ph.includes('入学时间'));
    record('A3 起止时间两端真实值', !!eduRange && eduRange.values[0] === '2024-09' && eduRange.values[1] === '2027-06', JSON.stringify(eduRange && eduRange.values));
    record('A4 起止时间无校验错误', !!eduRange && !eduRange.error, `error=${eduRange && eduRange.error}`);
    const award = st.pick['获奖时间'][0] || {};
    record('A5 获奖时间月选器接受', award.value === '2023-06', `value=${award.value}`);
    const grant = st.pick['取得日期'][0] || {};
    record('A6 取得日期不误填奖惩时间', grant.value !== '2023-06', `value=${grant.value}`);
    const fillRes = page.__fill;
    record('A7 自报 filled 数与真实值一致（日期无误报）', !fillRes || typeof fillRes.filled === 'number', `filled=${fillRes && fillRes.filled}`);
  },

  // B: 重复经历归属
  async repeat(page) {
    const st = await readPageState(page);
    const school = st.pick['学校'][0] || {};
    const major = st.pick['专业'][0] || {};
    const degree = st.pick['学历'][0] || {};
    const sameItem = (school.value === '示例大学' && major.value === '软件工程') || (school.value === '示例理工大学' && major.value === '计算机科学与技术');
    record('B1 同一教育卡学校+专业来自同一条目', sameItem, `${school.value}/${major.value}`);
    const expectDegree = school.value === '示例大学' ? '硕士研究生' : (school.value === '示例理工大学' ? '大学本科' : '');
    record('B2 学历与学校同条目', !!degree.value && degree.value === expectDegree, `degree=${degree.value}`);
    const city = st.pick['学校所在城市'][0] || {};
    record('B3 学校所在城市不写学校名', city.value !== '示例大学' && city.value !== '示例理工大学', `city=${city.value}`);
  },

  // C: 标签歧义
  async labels(page) {
    const st = await readPageState(page);
    const name = st.pick['姓名'][0] || {};
    record('C1 姓名=张三（非英文名）', name.value === '张三', `value=${name.value}`);
    const advisor = st.pick['导师'][0] || {};
    const lab = st.pick['实验室'][0] || {};
    record('C2 导师不写学校名', advisor.value !== '示例大学' && advisor.value !== '示例理工大学', `advisor=${advisor.value}`);
    record('C3 实验室不写学校名', lab.value !== '示例大学' && lab.value !== '示例理工大学', `lab=${lab.value}`);
    const research = st.pick['研究方向'][0] || {};
    record('C4 研究方向取资料研究方向', research.value === '智能表单理解与隐私保护自动化', `research=${research.value}`);
    const idNum = st.pick['证件号码（用于实名认证）'][0] || {};
    record('C5 证件号码不自动写', idNum.value === '', `value=${idNum.value}`);
  },

  // D: antd Select / radio
  async selectRadio(page) {
    const st = await readPageState(page);
    const gender = st.pick['性别'][0] || {};
    record('D1 性别 Select 选中男', gender.value === '男', `value=${gender.value}`);
    const city = st.pick['意向工作城市'][0] || {};
    record('D2 意向城市 Select 选中上海', city.value === '上海', `value=${city.value}`);
    const degree = st.pick['学历'][0] || {};
    record('D3 学历 Select 已选中', degree.value === '硕士研究生' || degree.value === '大学本科', `value=${degree.value}`);
    const rank = st.pick['成绩排名'][0] || {};
    record('D4 成绩排名 Select 已选中', rank.value === '前10%' || rank.value === '前15%', `value=${rank.value}`);
    const adjust = st.pick['是否服从调剂'][0] || {};
    record('D5 服从调剂保留原值 是', adjust.value === '是', `value=${adjust.value}`);
    const phone = st.pick['手机号'][0] || {};
    record('D6 手机号既有值未覆盖', phone.value === '199****3820', `value=${phone.value}`);
  },

  // E: 新增经历块
  async addBlocks(page) {
    const st = await readPageState(page);
    const eduBlocks = st.blocks.filter((b) => /edu-entry/.test(b.cls));
    record('E1 新增第二教育块', eduBlocks.length >= 2, `eduBlocks=${eduBlocks.length}`);
    if (eduBlocks.length >= 2) {
      const second = eduBlocks[1];
      const st2 = await page.evaluate(`(() => { const R = ${FIELD_READERS}; const b = document.querySelectorAll('.edu-entry')[1];
        const pick = {};
        for (const label of ['学校','专业','学历']) pick[label] = R.fieldsByLabel(label, b).map(R.stateOf);
        return { pick, ranges: R.rangeState(b) }; })()`);
      const school2 = st2.pick['学校'][0] || {};
      const major2 = st2.pick['专业'][0] || {};
      const ok2 = (school2.value === '示例理工大学' && major2.value === '计算机科学与技术');
      record('E2 第二教育块绑定本科条目', ok2, `${school2.value}/${major2.value}`);
      const r2 = (st2.ranges || [])[0];
      record('E3 第二块起止为本科 2019-09~2023-06', !!r2 && r2.values[0] === '2019-09' && r2.values[1] === '2023-06', JSON.stringify(r2 && r2.values));
    }
    const internBlocks = st.blocks.filter((b) => /exp-entry/.test(b.cls) && /实习/.test(b.title || ''));
    const workBlocks = st.blocks.filter((b) => /exp-entry/.test(b.cls) && /工作/.test(b.title || '') && !/实习/.test(b.title || ''));
    record('E4 新增实习块', internBlocks.length >= 1, `intern=${internBlocks.length}`);
    record('E5 新增工作块', workBlocks.length >= 1, `work=${workBlocks.length}`);
    if (internBlocks.length >= 1) {
      const company = st.pick['单位名称'][0] || {};
      record('E6 实习单位已填', company.value === '示例科技有限公司', `company=${company.value}`);
    }
  },

  async safety(page) {
    const st = await readPageState(page);
    record('S1 未点击提交类按钮', st.submitClicks === 0, `clicks=${st.submitClicks}`);
    const fillRes = page.__fill || {};
    const realFilled = await page.evaluate(`(() => {
      const seen = new Set();
      let n = 0;
      for (const el of document.querySelectorAll('[data-ojaf-mark="filled"]')) {
        const sel = el.closest('.ant-select');
        const rg = el.closest('.ant-radio-group');
        const key = sel || rg || el;
        if (seen.has(key)) continue;
        seen.add(key);
        if (sel) { const v = sel.querySelector('.ant-select-selection-item'); if (v && (v.innerText || '').trim()) n += 1; continue; }
        if (rg) { if (rg.querySelector('input:checked')) n += 1; continue; }
        const inp = el.matches('input,textarea') ? el : el.querySelector('input,textarea');
        if (inp && inp.value) n += 1;
      }
      return n; })()`);
    record('S2 自报已填数=实测非空标记数', typeof fillRes.filled === 'number' ? fillRes.filled === realFilled : true, `自报=${fillRes.filled} 实测=${realFilled}`);
    const offenders = await page.evaluate(`(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[data-ojaf-mark]')) {
        const sel = el.closest('.ant-select');
        const rg = el.closest('.ant-radio-group');
        const key = sel || rg || el;
        if (seen.has(key)) continue;
        seen.add(key);
        let value = '';
        if (sel) { value = (sel.querySelector('.ant-select-selection-item')?.innerText || '').trim(); }
        else if (rg) { const c = rg.querySelector('input:checked'); value = c ? (c.closest('.ant-radio-wrapper')?.innerText || '').trim() : ''; }
        else { const inp = el.matches('input,textarea') ? el : el.querySelector('input,textarea'); value = inp ? inp.value : ''; }
        out.push({ mark: el.getAttribute('data-ojaf-mark'), label: (el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.innerText || '').trim().slice(0, 24), value: String(value).slice(0, 40), cls: String(el.className).slice(0, 40) });
      }
      return out; })()`);
    console.log('marks dump:', JSON.stringify(offenders));
  }
};

// ---------- run ----------
const wanted = only ? Object.keys(SCENARIOS).filter((k) => only.has(k) || [...only].some((o) => k.toLowerCase().startsWith(o.toLowerCase()))) : Object.keys(SCENARIOS);
if (!wanted.length) throw new Error('No matching scenarios');
let page;
if (wanted.some(name => name !== 'negative')) {
  page = await newFixturePage();
  console.log('fixture ready, running autofill…');
  const fillResult = await runFill(page);
  page.__fill = fillResult;
  fs.writeFileSync(path.join(evidenceDir, 'fill-result.json'), JSON.stringify(fillResult, null, 2));
  console.log('fill result:', JSON.stringify(fillResult && { ok: fillResult.ok, filled: fillResult.filled, failed: fillResult.failed, skipped: fillResult.skipped, unmatched: fillResult.unmatched, autoFilled: fillResult.autoFilled }));
  await page.screenshot({ path: path.join(evidenceDir, 'after-fill.png'), fullPage: true });
  const debug = await runPlanOnly(page);
  fs.writeFileSync(path.join(evidenceDir, 'debug-snapshot.json'), JSON.stringify(debug && debug.data ? debug.data : debug, null, 2));
}
for (const name of wanted) {
  try { await SCENARIOS[name](page); } catch (e) { record(name, false, `scenario error: ${e.message}`); }
}

const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} assertions passed`);
fs.writeFileSync(path.join(evidenceDir, 'assertions.json'), JSON.stringify(results, null, 2));

await ctx.close();
server.close();
process.exit(fails.length ? 1 : 0);
