// 11100101 10001000 10011000 11100110 10000000 10011101 11100111 10111110 10111101 11100110 10001000 10010001 11100111 10001000 10110001 11100100 10111101 10100000
/**
 * ====================================================================
 *  multi-engine-search-mcp  v2.8.2
 *  功能：文本搜索 + URL抓取 + 截图保存到项目根目录/screenshots/
 *  
 *  新增：自动识别 index.js 所在目录，截图保存于此，并返回路径 URL
 * ====================================================================
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URLSearchParams } from 'url';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer';
import pLimit from 'p-limit';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';

// ============================ 获取当前文件所在目录 ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // 这就是 index.js 所在目录

// ============================ 配置 ============================
const CONFIG = {
  cacheTTL: 3 * 60 * 1000,
  contentCacheTTL: 30 * 60 * 1000,
  maxResults: 5,
  requestTimeout: 15000,
  maxRetries: 2,
  maxContentLength: 500,
  fetchTimeout: 10000,
  usePuppeteerFallback: true,
  proxy: process.env.PROXY || '',
  maxEngineParallel: 2,
  maxFetchParallel: 5,
  logDir: path.join(__dirname, 'logs'),                     // 日志目录
  delayMin: 300,
  delayMax: 1500,
  screenshotTimeout: 30000,
  screenshotQuality: 80,
  screenshotSaveDir: path.join(__dirname, 'screenshots'),   // 截图目录（与 index.js 同级）
};

// ============================ 日志 ============================
let logStream = null;
async function initLog() {
  try {
    await fs.mkdir(CONFIG.logDir, { recursive: true });
    const logPath = path.join(CONFIG.logDir, `error-${new Date().toISOString().slice(0,10)}.log`);
    logStream = createWriteStream(logPath, { flags: 'a' });
    console.error(`✅ 日志文件: ${logPath}`);
  } catch (err) {
    console.error(`⚠️ 日志初始化失败（仅控制台输出）: ${err.message}`);
    logStream = null;
  }
}
function log(level, msg, meta = {}) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}\n`;
  console.error(line.trim());
  if ((level === 'ERROR' || level === 'WARN') && logStream) {
    logStream.write(line);
  }
}
const logError = (msg, meta) => log('ERROR', msg, meta);
const logWarn  = (msg, meta) => log('WARN',  msg, meta);
const logInfo  = (msg, meta) => log('INFO',  msg, meta);

// ============================ 工具 ============================
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
];
let uaIdx = 0;
const nextUA = () => userAgents[uaIdx++ % userAgents.length];
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = () => delay(CONFIG.delayMin + Math.random() * (CONFIG.delayMax - CONFIG.delayMin));

class McpError extends Error {
  constructor(code, msg, userMsg) { super(msg); this.code = code; this.userMessage = userMsg || msg; this.isMcpError = true; }
}

// ============================ 缓存 ============================
class Cache {
  constructor(ttl) { this.ttl = ttl; this.map = new Map(); }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) { this.map.delete(key); return null; }
    return entry.data;
  }
  set(key, data) { this.map.set(key, { data, ts: Date.now() }); }
}
const searchCache = new Cache(CONFIG.cacheTTL);
const contentCache = new Cache(CONFIG.contentCacheTTL);

// ============================ 引擎抓取（文本搜索） ============================
async function fetchBaidu(query, max) {
  await randomDelay();
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': nextUA(), 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: CONFIG.requestTimeout,
    });
    const $ = cheerio.load(res.data);
    const results = [];
    for (const sel of ['.result', '.c-container']) {
      const elems = $(sel);
      if (elems.length) {
        elems.each((i, el) => {
          if (i >= max) return false;
          const titleEl = $(el).find('h3 a, .t a');
          let title = titleEl.text().trim();
          let link = titleEl.attr('href');
          if (!title || !link) return;
          if (link.startsWith('/url?q=')) {
            const qs = new URLSearchParams(link.split('?')[1]);
            link = qs.get('q') || link;
          } else if (!link.startsWith('http')) {
            link = 'https://www.baidu.com' + link;
          }
          const snippet = $(el).find('.c-abstract, .content-abstract, .abs').text().trim();
          results.push({ title, link, snippet, source: 'baidu' });
        });
        if (results.length) break;
      }
    }
    return results;
  } catch (err) {
    logError('百度失败', { query, error: err.message });
    throw new McpError('ENGINE_FAIL', err.message, '百度暂时不可用');
  }
}

async function fetchBing(query, max) {
  await randomDelay();
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': nextUA(), 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: CONFIG.requestTimeout,
      maxRedirects: 5,
    });
    const $ = cheerio.load(res.data);
    let items = [];
    const standard = $('#b_results .b_algo');
    if (standard.length) items = standard.toArray();
    else {
      const fallback = $('.b_algo, .b_slidebar');
      if (fallback.length) items = fallback.toArray();
      else {
        const set = new Set();
        $('h2 a, h3 a').each((_, el) => {
          const parent = $(el).closest('li, div, section');
          if (parent.length) set.add(parent[0]);
        });
        items = Array.from(set);
      }
    }
    const results = [];
    let count = 0;
    for (const elem of items) {
      if (count >= max) break;
      const $el = $(elem);
      const titleEl = $el.find('h2 a, h3 a').first();
      let title = titleEl.text().trim();
      let link = titleEl.attr('href');
      if (!title || !link) continue;
      if (link.startsWith('/url?q=')) {
        const qs = new URLSearchParams(link.split('?')[1]);
        link = qs.get('q') || link;
      } else if (!link.startsWith('http')) {
        link = 'https://www.bing.com' + link;
      }
      let snippet = $el.find('.b_caption p, .b_snippet, .b_snippetText, .snippet').text().trim();
      if (!snippet) snippet = $el.find('p').first().text().trim();
      results.push({ title, link, snippet, source: 'bing' });
      count++;
    }
    return results;
  } catch (err) {
    logError('必应失败', { query, error: err.message });
    throw new McpError('ENGINE_FAIL', err.message, '必应暂时不可用');
  }
}

async function fetchSogou(query, max) {
  await randomDelay();
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': nextUA(), 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: CONFIG.requestTimeout,
    });
    const $ = cheerio.load(res.data);
    const results = [];
    $('.vrwrap, .rb, .pt').each((i, el) => {
      if (i >= max) return false;
      const titleEl = $(el).find('h3 a, .pt a');
      let title = titleEl.text().trim();
      let link = titleEl.attr('href');
      if (!title || !link) return;
      if (link.startsWith('/link?url=')) {
        const qs = new URLSearchParams(link.split('?')[1]);
        link = qs.get('url') || link;
      } else if (!link.startsWith('http')) {
        link = 'https://www.sogou.com' + link;
      }
      const snippet = $(el).find('.p, .str_info').text().trim();
      results.push({ title, link, snippet, source: 'sogou' });
    });
    return results;
  } catch (err) {
    logError('搜狗失败', { query, error: err.message });
    throw new McpError('ENGINE_FAIL', err.message, '搜狗暂时不可用');
  }
}

// ============================ 正文抓取 ============================
let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    logInfo('Puppeteer 已启动');
  }
  return browser;
}

async function fetchWithAxios(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': nextUA(), 'Accept': 'text/html,application/xhtml+xml' },
    timeout: CONFIG.fetchTimeout,
    maxRedirects: 5,
    proxy: CONFIG.proxy ? { host: CONFIG.proxy, port: 8080 } : false,
  });
  const html = res.data;
  const dom = new JSDOM(html);
  const article = new Readability(dom.window.document).parse();
  if (article?.textContent?.length > 50) return article.textContent.trim();
  const $ = cheerio.load(html);
  for (const sel of ['article', 'main', '.content', '#content', '.post-content', '.article-content']) {
    const el = $(sel);
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 50) return text;
    }
  }
  return $('meta[name="description"]').attr('content') || '';
}

async function fetchWithPuppeteer(url) {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setUserAgent(nextUA());
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.fetchTimeout });
    return await page.evaluate(() => {
      const remove = ['script','style','noscript','iframe','nav','header','footer','aside'];
      remove.forEach(t => document.querySelectorAll(t).forEach(e => e.remove()));
      const art = document.querySelector('article, main, .content, #content, .post-content, .article-content');
      if (art) return art.textContent.trim();
      const body = document.body;
      if (!body) return '';
      const texts = [];
      const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(p);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          const t = n.textContent.trim();
          return t.length > 20 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let node;
      while ((node = walk.nextNode())) texts.push(node.textContent.trim());
      return texts.join('\n').slice(0, 5000);
    }) || '';
  } catch (err) {
    logWarn('Puppeteer失败', { url, error: err.message });
    return '';
  } finally { await page.close(); }
}

async function fetchPageContentWithRetry(url, retries = CONFIG.maxRetries) {
  const cached = contentCache.get(url);
  if (cached) return cached;
  let lastErr;
  for (let i = 1; i <= retries + 1; i++) {
    try {
      let content = await fetchWithAxios(url);
      if (!content && CONFIG.usePuppeteerFallback) content = await fetchWithPuppeteer(url);
      if (content) {
        content = content.slice(0, CONFIG.maxContentLength) + (content.length > CONFIG.maxContentLength ? '...' : '');
        contentCache.set(url, content);
        return content;
      }
    } catch (err) { lastErr = err; if (i <= retries) await delay(1000 * 2 ** (i-1)); }
  }
  logError('抓取最终失败', { url, error: lastErr?.message || '未知' });
  throw new McpError('FETCH_FAIL', `抓取失败 ${url}`, '抓取内容失败');
}

// ============================ 搜索聚合（文本） ============================
const engineLimiter = pLimit(CONFIG.maxEngineParallel);
const fetchLimiter = pLimit(CONFIG.maxFetchParallel);

function extractDate(text) {
  const m = text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
  return m ? new Date(m[1]).getTime() : null;
}

async function searchAllEngines(query, maxResults) {
  const cacheKey = `${query}_${maxResults}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logInfo('缓存命中', { query });
    return await Promise.all(cached.map(async item => {
      if (item.link) {
        try { const content = await fetchLimiter(() => fetchPageContentWithRetry(item.link)); return { ...item, content }; }
        catch { return { ...item, content: '' }; }
      }
      return item;
    }));
  }

  logInfo('搜索开始', { query });
  const [baidu, bing, sogou] = await Promise.allSettled([
    engineLimiter(() => fetchBaidu(query, maxResults * 2)),
    engineLimiter(() => fetchBing(query, maxResults * 2)),
    engineLimiter(() => fetchSogou(query, maxResults * 2)),
  ]);

  let all = [];
  const engines = ['baidu','bing','sogou'];
  [baidu, bing, sogou].forEach((res, idx) => {
    if (res.status === 'fulfilled') all = all.concat(res.value);
    else logWarn(`${engines[idx]} 失败`, { query, error: res.reason.message });
  });
  if (!all.length) return [];

  const seen = new Set();
  const unique = all.filter(item => {
    const key = item.link || item.title.slice(0,10);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const authority = ['kernel.org','ubuntu.com','debian.org','redhat.com','microsoft.com','github.com','arxiv.org','tencent.com','huawei.com','amazon.com'];
  const scored = unique.map(item => {
    let score = 0;
    const text = (item.title + ' ' + (item.snippet || '')).toLowerCase();
    keywords.forEach(kw => { if (text.includes(kw)) score += 2; });
    if (item.source === 'bing') score += 1;
    if (item.source === 'baidu') score += 0.5;
    const date = extractDate(item.snippet || item.title);
    if (date) {
      const days = (Date.now() - date) / (1000*60*60*24);
      if (days < 7) score += 10;
      else if (days < 30) score += 5;
      else if (days < 90) score += 2;
    }
    if (item.link) authority.forEach(d => { if (item.link.includes(d)) score += 3; });
    return { ...item, score };
  });
  scored.sort((a,b) => b.score - a.score);
  const final = scored.slice(0, maxResults);

  const withContent = await Promise.all(final.map(async item => {
    if (item.link) {
      try { const content = await fetchLimiter(() => fetchPageContentWithRetry(item.link)); return { ...item, content }; }
      catch { return { ...item, content: '' }; }
    }
    return item;
  }));

  searchCache.set(cacheKey, final.map(({ content, ...rest }) => rest));
  return withContent;
}

// ============================ 截图功能（保存到项目根目录/screenshots/） ============================
async function captureSearchPage(query, engine = 'baidu', fullPage = false) {
  const urls = {
    baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    sogou: `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
  };
  const url = urls[engine.toLowerCase()];
  if (!url) throw new McpError('INVALID_ENGINE', `不支持的引擎: ${engine}`);

  // 确保截图目录存在
  await fs.mkdir(CONFIG.screenshotSaveDir, { recursive: true });

  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.screenshotTimeout });
    await page.waitForSelector('body', { timeout: 5000 });
    await delay(2000);

    const opts = { encoding: 'base64', type: 'jpeg', quality: CONFIG.screenshotQuality };
    if (fullPage) opts.fullPage = true;

    const base64 = await page.screenshot(opts);
    const dims = await page.evaluate((fullPage) => ({
      width: document.documentElement.scrollWidth || document.body.scrollWidth,
      height: fullPage ? (document.documentElement.scrollHeight || document.body.scrollHeight) : window.innerHeight,
    }), fullPage);

    // ---- 保存图片到文件 ----
    const timestamp = Date.now();
    const fileName = `screenshot-${timestamp}-${query.slice(0,30).replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;
    const filePath = path.join(CONFIG.screenshotSaveDir, fileName);
    await fs.writeFile(filePath, Buffer.from(base64, 'base64'));

    // 生成路径信息
    const absPath = filePath;
    const fileUrl = `file://${absPath}`;
    const relPath = `./screenshots/${fileName}`;

    return {
      base64,          // 仍可包含 Base64（可选）
      mimeType: 'image/jpeg',
      width: dims.width,
      height: dims.height,
      engine,
      query,
      fullPage,
      filePath: absPath,
      fileUrl: fileUrl,
      relPath: relPath,
      fileName: fileName,
    };
  } catch (err) {
    logError('截图失败', { url, error: err.message, stack: err.stack });
    throw new McpError('SCREENSHOT_FAIL', err.message, '页面截图失败，可能页面结构变化或超时');
  } finally {
    await page.close();
  }
}

// ============================ MCP 服务 ============================
const server = new Server(
  { name: 'multi-engine-search-mcp', version: '2.8.2' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: '通用文本搜索（聚合百度、必应、搜狗）',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] }
    },
    {
      name: 'tech_search',
      description: '技术类文本搜索',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] }
    },
    {
      name: 'fetch_url',
      description: '抓取指定URL正文内容',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, max_length: { type: 'number' } }, required: ['url'] }
    },
    {
      name: 'search_page_screenshot',
      description: '获取搜索引擎结果页面的截图，并保存到本地，返回文件路径和URL',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          engine: { type: 'string', enum: ['baidu', 'bing', 'sogou'], default: 'baidu' },
          full_page: { type: 'boolean', default: false }
        },
        required: ['query']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'search' || name === 'tech_search') {
      const query = args?.query;
      if (!query) throw new McpError('INVALID_ARG', '缺少 query', '请提供搜索关键词');
      const max = Math.min(Math.max(parseInt(args?.max_results) || CONFIG.maxResults, 1), 10);
      const results = await searchAllEngines(query, max);
      if (!results.length) return { content: [{ type: 'text', text: `😅 未找到“${query}”相关信息` }] };
      let label = name === 'tech_search' ? '🔬 技术搜索' : '🔍 通用搜索';
      let text = `${label}“${query}”结果（${results.length} 条）：\n\n`;
      results.forEach((r, i) => {
        text += `${i+1}. [${r.source}] ${r.title}\n`;
        if (r.snippet) text += `   ${r.snippet}\n`;
        if (r.content) text += `   📄 ${r.content}\n`;
        text += `   🔗 ${r.link}\n\n`;
      });
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'fetch_url') {
      const url = args?.url;
      if (!url) throw new McpError('INVALID_ARG', '缺少 url', '请提供URL');
      try { new URL(url); } catch { throw new McpError('INVALID_ARG', 'URL格式错误', 'URL需包含 http:// 或 https://'); }
      const content = await fetchPageContentWithRetry(url);
      return { content: [{ type: 'text', text: `📄 抓取 ${url} 内容：\n\n${content || '（空）'}` }] };
    }

    if (name === 'search_page_screenshot') {
      const query = args?.query;
      if (!query) throw new McpError('INVALID_ARG', '缺少 query', '请提供搜索关键词');
      const engine = args?.engine || 'baidu';
      const fullPage = args?.full_page === true;
      const result = await captureSearchPage(query, engine, fullPage);

      // 返回图片数据和路径信息
      const textMsg = `📷 截图已保存\n` +
                      `- 引擎: ${result.engine}\n` +
                      `- 关键词: "${result.query}"\n` +
                      `- 尺寸: ${result.width}x${result.height}\n` +
                      `- 完整页面: ${result.fullPage ? '是' : '否'}\n` +
                      `- 文件路径: ${result.filePath}\n` +
                      `- 文件 URL: ${result.fileUrl}\n` +
                      `- 相对路径: ${result.relPath}\n\n` +
                      `![截图](${result.relPath})`;  // Markdown 图片引用

      return {
        content: [
          { type: 'image', data: result.base64, mimeType: result.mimeType },
          { type: 'text', text: textMsg }
        ]
      };
    }

    throw new McpError('UNKNOWN_TOOL', `未知工具 ${name}`, `工具“${name}”不存在`);
  } catch (err) {
    if (err.isMcpError) {
      logError('调用错误', { name, code: err.code, userMsg: err.userMessage });
      return { content: [{ type: 'text', text: `❌ ${err.userMessage}` }], isError: true };
    }
    logError('未捕获异常', { name, error: err.message, stack: err.stack });
    return { content: [{ type: 'text', text: `❌ 内部错误: ${err.message}` }], isError: true };
  }
});

// ============================ 生命周期 ============================
async function graceful(signal) {
  logInfo(`收到 ${signal}，正在关闭...`);
  if (browser) await browser.close();
  if (logStream) logStream.end();
  process.exit(0);
}
process.on('SIGINT', () => graceful('SIGINT'));
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('uncaughtException', err => logError('未捕获异常', { error: err.message, stack: err.stack }));
process.on('unhandledRejection', reason => logError('未处理拒绝', { reason: reason?.message || reason }));

// ============================ 启动 ============================
await initLog();
const transport = new StdioServerTransport();
await server.connect(transport);
logInfo('✅ MCP 搜索服务 v2.8.2 已启动（截图保存到项目根目录/screenshots/）');
