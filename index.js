import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URLSearchParams } from 'url';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer';

// ============================
// 1. 配置
// ============================
const CONFIG = {
  cacheTTL: 5 * 60 * 1000,          // 搜索结果缓存 5分钟
  contentCacheTTL: 60 * 60 * 1000,  // 正文缓存 1小时
  maxResults: 5,
  requestTimeout: 15000,
  maxRetries: 2,
  maxContentLength: 500,
  fetchTimeout: 10000,
  usePuppeteerFallback: true,
  proxy: process.env.PROXY || '',
};

// ============================
// 2. 工具函数：UA轮换、延迟
// ============================
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
];
let uaIndex = 0;
const getNextUA = () => userAgents[uaIndex++ % userAgents.length];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================
// 3. 缓存类
// ============================
class Cache {
  constructor(ttl) {
    this.ttl = ttl;
    this.cache = new Map();
  }
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }
  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}
const searchCache = new Cache(CONFIG.cacheTTL);
const contentCache = new Cache(CONFIG.contentCacheTTL);

// ============================
// 4. 搜索引擎抓取器
// ============================
async function fetchBaidu(query, max) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': getNextUA(), 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: CONFIG.requestTimeout,
  });
  const $ = cheerio.load(response.data);
  const results = [];
  const selectors = ['.result', '.c-container'];
  for (const sel of selectors) {
    const elems = $(sel);
    if (elems.length) {
      elems.each((i, elem) => {
        if (i >= max) return false;
        const titleElem = $(elem).find('h3 a, .t a');
        let title = titleElem.text().trim();
        let link = titleElem.attr('href');
        if (!title || !link) return;
        if (link.startsWith('/url?q=')) {
          const qs = new URLSearchParams(link.split('?')[1]);
          link = qs.get('q') || link;
        } else if (link && !link.startsWith('http')) {
          link = 'https://www.baidu.com' + link;
        }
        const snippet = $(elem).find('.c-abstract, .content-abstract, .abs').text().trim();
        results.push({ title, link, snippet, source: 'baidu' });
      });
      if (results.length) break;
    }
  }
  return results;
}

// ========== 修复 fetchBing（多重选择器降级） ==========
async function fetchBing(query, max) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await axios.get(url, {
    headers: {
      'User-Agent': getNextUA(),
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: CONFIG.requestTimeout,
    maxRedirects: 5,
  });

  const $ = cheerio.load(response.data);
  const results = [];
  let items = [];

  // 尝试多种选择器，适应国内外不同版本
  const standard = $('#b_results .b_algo');
  if (standard.length > 0) {
    items = standard.toArray();
  } else {
    const fallback = $('.b_algo, .b_slidebar');
    if (fallback.length > 0) {
      items = fallback.toArray();
    } else {
      // 通用降级：查找 h2/h3 内的链接，取最近的块级父容器
      const linkParents = new Set();
      $('h2 a, h3 a').each((_, el) => {
        const parent = $(el).closest('li, div, section');
        if (parent.length) {
          linkParents.add(parent[0]);
        }
      });
      items = Array.from(linkParents);
    }
  }

  let count = 0;
  for (const elem of items) {
    if (count >= max) break;
    const $elem = $(elem);

    const titleElem = $elem.find('h2 a, h3 a').first();
    let title = titleElem.text().trim();
    let link = titleElem.attr('href');
    if (!title || !link) continue;

    // 处理重定向链接
    if (link.startsWith('/url?q=')) {
      const qs = new URLSearchParams(link.split('?')[1]);
      link = qs.get('q') || link;
    } else if (link && !link.startsWith('http')) {
      link = 'https://www.bing.com' + link;
    }

    // 摘要提取
    let snippet = $elem.find('.b_caption p, .b_snippet, .b_snippetText, .snippet').text().trim();
    if (!snippet) {
      snippet = $elem.find('p').first().text().trim();
    }

    results.push({ title, link, snippet, source: 'bing' });
    count++;
  }
  return results;
}

async function fetchSogou(query, max) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': getNextUA(), 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: CONFIG.requestTimeout,
  });
  const $ = cheerio.load(response.data);
  const results = [];
  $('.vrwrap, .rb, .pt').each((i, elem) => {
    if (i >= max) return false;
    const titleElem = $(elem).find('h3 a, .pt a');
    let title = titleElem.text().trim();
    let link = titleElem.attr('href');
    if (!title || !link) return;
    if (link.startsWith('/link?url=')) {
      const qs = new URLSearchParams(link.split('?')[1]);
      link = qs.get('url') || link;
    } else if (link && !link.startsWith('http')) {
      link = 'https://www.sogou.com' + link;
    }
    const snippet = $(elem).find('.p, .str_info').text().trim();
    results.push({ title, link, snippet, source: 'sogou' });
  });
  return results;
}

// ============================
// 5. 正文抓取（增强版：axios + puppeteer 降级）
// ============================
async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': getNextUA(), 'Accept': 'text/html,application/xhtml+xml' },
    timeout: CONFIG.fetchTimeout,
    maxRedirects: 5,
    proxy: CONFIG.proxy ? { host: CONFIG.proxy, port: 8080 } : false,
  });
  const html = response.data;
  const dom = new JSDOM(html);
  const reader = new Readability(dom.window.document);
  let article = reader.parse();
  let content = '';
  if (article && article.textContent && article.textContent.length > 50) {
    content = article.textContent.trim();
  } else {
    const $ = cheerio.load(html);
    const selectors = ['article', 'main', '.content', '#content', '.post-content', '.article-content'];
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        const text = el.text().trim();
        if (text.length > 50) {
          content = text;
          break;
        }
      }
    }
    if (!content) {
      const desc = $('meta[name="description"]').attr('content');
      if (desc) content = desc;
    }
  }
  return content || '';
}

async function fetchWithPuppeteer(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(getNextUA());
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.fetchTimeout });
    const content = await page.evaluate(() => {
      // 移除干扰元素
      const removeTags = ['script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside'];
      removeTags.forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });

      // 尝试提取文章主体
      const article = document.querySelector('article, main, .content, #content, .post-content, .article-content');
      if (article) {
        return article.textContent.trim();
      }

      // 否则获取 body 文本，但过滤短文本和隐藏元素
      const body = document.body;
      if (!body) return '';
      const texts = [];
      const walker = document.createTreeWalker(
        body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            const text = node.textContent.trim();
            if (text.length > 20) return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_REJECT;
          }
        }
      );
      let node;
      while ((node = walker.nextNode())) {
        texts.push(node.textContent.trim());
      }
      return texts.join('\n').slice(0, 5000);
    });
    return content || '';
  } catch (err) {
    return '';
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchPageContent(url) {
  const cached = contentCache.get(url);
  if (cached) return cached;

  let content = '';
  try {
    content = await fetchWithAxios(url);
  } catch (err) {
    console.error(`Axios 抓取失败: ${err.message}`);
  }

  if ((!content || content.length < 50) && CONFIG.usePuppeteerFallback) {
    content = await fetchWithPuppeteer(url);
  }

  if (content) {
    content = content.slice(0, CONFIG.maxContentLength) + (content.length > CONFIG.maxContentLength ? '...' : '');
    contentCache.set(url, content);
  }
  return content || '';
}

// ============================
// 6. 搜索聚合 + 正文抓取
// ============================
async function searchAllEngines(query, maxResults) {
  const cacheKey = `${query}_${maxResults}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.error('✅ 命中搜索结果缓存');
    const withContent = await Promise.all(
      cached.map(async (item) => {
        if (item.link) {
          const content = await fetchPageContent(item.link);
          return { ...item, content };
        }
        return item;
      })
    );
    return withContent;
  }

  const [baiduRes, bingRes, sogouRes] = await Promise.allSettled([
    fetchBaidu(query, maxResults * 2),
    fetchBing(query, maxResults * 2),
    fetchSogou(query, maxResults * 2),
  ]);

  let allResults = [];
  const engines = ['baidu', 'bing', 'sogou'];
  [baiduRes, bingRes, sogouRes].forEach((res, idx) => {
    if (res.status === 'fulfilled') allResults = allResults.concat(res.value);
    else console.error(`⚠️ 引擎 ${engines[idx]} 抓取失败:`, res.reason.message);
  });

  if (allResults.length === 0) return [];

  // 去重
  const seen = new Set();
  const unique = [];
  for (const item of allResults) {
    const key = item.link || item.title.substring(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  // 排序（给权威域名加分）
  const keywords = query.split(/\s+/).filter(w => w.length > 1);
  const authorityDomains = ['kernel.org', 'ubuntu.com', 'debian.org', 'redhat.com', 'microsoft.com', 'github.com', 'arxiv.org', 'tencent.com', 'huawei.com', 'amazon.com'];
  const scored = unique.map(item => {
    let score = 0;
    const text = (item.title + ' ' + (item.snippet || '')).toLowerCase();
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) score += 1;
    }
    if (item.source === 'baidu') score += 0.5;
    if (item.link) {
      for (const domain of authorityDomains) {
        if (item.link.includes(domain)) { score += 2; break; }
      }
    }
    return { ...item, score };
  });
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  const finalResults = scored.slice(0, maxResults);

  // 抓取正文
  const withContent = await Promise.all(
    finalResults.map(async (item) => {
      if (item.link) {
        const content = await fetchPageContent(item.link);
        return { ...item, content };
      }
      return item;
    })
  );

  searchCache.set(cacheKey, finalResults.map(({ content, ...rest }) => rest));
  return withContent;
}

// ============================
// 7. MCP 服务器
// ============================
const server = new Server(
  {
    name: 'multi-engine-search-mcp',
    version: '2.3.0',
  },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: '通用搜索引擎，适用于新闻、百科、生活常识等常见话题。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'number', description: '返回结果数量（1-10），默认5' },
        },
        required: ['query'],
      },
    },
    {
      name: 'tech_search',
      description: '🔬 专用技术搜索，用于技术类问题：Linux 内核漏洞、编程框架版本、安全公告、硬件规范、开源项目文档、技术标准等。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '技术相关的搜索关键词，尽量精确' },
          max_results: { type: 'number', description: '返回结果数量（1-10），默认5' },
        },
        required: ['query'],
      },
    },
    {
      name: 'fetch_url',
      description: '直接抓取指定 URL 的网页正文内容，支持动态页面（通过 Puppeteer 降级）。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的网页地址（包含 http:// 或 https://）' },
          max_length: { type: 'number', description: '返回内容最大长度（默认 500 字符）' },
        },
        required: ['url'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search' || name === 'tech_search') {
    const { query, max_results = CONFIG.maxResults } = args || {};
    if (!query) throw new Error('缺少查询参数 query');
    const max = Math.min(Math.max(parseInt(max_results) || CONFIG.maxResults, 1), 10);
    const results = await searchAllEngines(query, max);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `😅 未找到关于“${query}”的信息，请尝试其他关键词。` }] };
    }
    let label = name === 'tech_search' ? '🔬 技术搜索' : '🔍 通用搜索';
    let text = `${label}“${query}”的结果（共 ${results.length} 条，来自 ${new Set(results.map(r=>r.source)).size} 个引擎）：\n\n`;
    results.forEach((r, i) => {
      text += `${i+1}. [${r.source}] ${r.title}\n`;
      if (r.snippet) text += `   ${r.snippet}\n`;
      if (r.content) text += `   📄 ${r.content}\n`;
      text += `   🔗 ${r.link}\n\n`;
    });
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'fetch_url') {
    const { url, max_length = 500 } = args || {};
    if (!url) throw new Error('缺少 URL 参数');
    try { new URL(url); } catch { throw new Error('无效的 URL'); }
    const content = await fetchPageContent(url);
    const finalContent = content || '（无法抓取内容，可能是反爬或页面结构复杂）';
    return {
      content: [{ type: 'text', text: `📄 从 ${url} 抓取的内容（截取前 ${max_length} 字符）：\n\n${finalContent}` }],
    };
  }

  throw new Error(`未知工具: ${name}`);
});

// ============================
// 8. 启动
// ============================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('✅ 多引擎搜索 MCP 服务器 v2.3.0 已启动（含 tech_search 专用工具）');

// 导出供测试脚本使用
export { searchAllEngines };
