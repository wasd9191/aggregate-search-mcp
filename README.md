# aggregate-search-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**aggregate-search-mcp** – 一个轻量级、无需 API 密钥的 MCP 服务器，为 LM Studio 等客户端提供百度、必应、搜狗三引擎聚合搜索能力。内置缓存、反爬策略和结果去重排序，**同时支持直接抓取任意 URL 的正文内容**。

## ✨ 特性

- 🔍 **多引擎聚合** – 同时抓取百度、必应（Bing）、搜狗，合并结果，按相关性排序
- 🚫 **无需任何 API Key** – 模拟真实浏览器请求，直接抓取公开搜索结果
- 📄 **正文抓取** – 自动抓取搜索结果页面的正文内容，为模型提供丰富上下文
- 🌐 **直接 URL 抓取** – 提供 `fetch_url` 工具，可单独抓取任意网页的正文
- 🧩 **动态渲染降级** – 当静态抓取失败时，自动启用 Puppeteer 无头浏览器，大幅提升成功率
- ⚡ **双重缓存** – 搜索结果缓存（5分钟）+ 正文缓存（1小时），减少重复请求
- 🛡️ **反爬策略** – User-Agent 轮换 + 请求重试退避 + 可选代理
- 💾 **极低资源占用** – 仅依赖 Node.js 运行时，内存常驻约 30–50 MB（Puppeteer 按需启动）
- 🔧 **灵活可调** – 可配置缓存时间、最大结果数、超时、抓取引擎等参数
- 🧩 **适配 LM Studio** – 完美兼容 MCP 协议，即插即用

## 🚀 快速开始

### 1. 克隆并安装依赖

```bash
git clone https://github.com/你的用户名/aggregate-search-mcp.git
cd aggregate-search-mcp
npm install


    注意：安装过程中会下载 Chromium（约 150MB），首次安装稍慢，但会极大提升动态页面的抓取成功率。

###2. 配置 LM Studio

在 LM Studio 的 MCP 设置中编辑 mcp.json（通常位于 ~/.lmstudio/mcp.json 或设置界面内），添加：

{
  "mcpServers": {
    "multi-search": {
      "command": "node",
      "args": ["/你的绝对路径/aggregate-search-mcp/index.js"],
      "env": {}
    }
  }
}



保存并重启 LM Studio 的 MCP 服务。
###3. 在对话中使用

加载任意支持工具调用的模型（如 Qwen、DeepSeek 等），输入


搜索今天的科技新闻


模型将自动调用 search 工具，返回来自多个引擎的综合结果，并附带正文摘要。

你也可以直接让模型抓取特定网页：


抓取 https://www.baidu.com

模型会调用 fetch_url 工具，返回该页面的正文内容。


搜索流程

    查询输入 – 用户或模型发起搜索请求

    缓存检查 – 若相同查询在 TTL 内，直接返回缓存结果

    并行抓取 – 同时向百度、必应、搜狗发起 HTTP 请求（模拟浏览器）

    解析与提取 – 使用 cheerio 解析 HTML，提取标题、链接、摘要

    去重与排序 – 按链接去重，根据关键词命中次数 + 来源权重排序

    正文抓取 – 对前 maxResults 条结果进行正文抓取（Axios + Puppeteer 降级）

    返回结果 – 将包含正文摘要的结构化结果返回给客户端

URL 直接抓取

    调用 fetch_url 工具，传入 URL

    先尝试 Axios 静态抓取 → 若失败或内容过短，自动降级为 Puppeteer 无头浏览器

    提取页面正文（使用 Readability 或常见容器选择器）

    返回截断后的正文内容

🧩 可用工具
search

    描述：多引擎搜索 + 自动抓取正文

    参数：

        query (string, 必需) – 搜索关键词

        max_results (number, 可选) – 返回结果数（1-10，默认5）

fetch_url

    描述：直接抓取指定 URL 的正文内容

    参数：

        url (string, 必需) – 完整的网页地址（包含协议）

        max_length (number, 可选) – 返回内容最大长度（默认500）

⚠️ 注意事项

    反爬风险 – 频繁请求可能触发搜索引擎的验证码，建议合理控制调用频率。

    页面结构变化 – 若百度/Bing/搜狗修改 HTML 布局，可能导致解析失效。届时需更新对应的 cheerio 选择器（见 fetchBaidu, fetchBing, fetchSogou 函数）。

    网络环境 – 确保服务器可正常访问上述搜索引擎（国内网络需能直连百度、搜狗，必应可能需代理）。

    Puppeteer 资源 – 首次启动时会下载 Chromium，之后按需启动无头浏览器，会占用额外内存（约 100-200 MB），但仅在 Axios 抓取失败时触发。

🤝 致谢与参考

本项目在设计和实现上，参考了 MCP 社区中许多优秀的开源项目，主要灵感来源如下：
📚 百度搜索 MCP 服务器

    caiyili/baidu-search-mcp – 核心的百度搜索功能灵感来源

    iflow-mcp/baidu-search-mcp – 提供项目结构参考

    @alex.ss/mcp-server-baidu-search – 不同实现思路

    Evilran/baidu-mcp-server – 提供网页搜索与内容抓取能力

🔍 多引擎搜索 MCP 服务器

    dlmufei/go-web-search-mcp – “多引擎聚合”的核心思想

    MemoryClear/claude-web-search-mcp – “并行搜索”和“智能去重”

    MetaSearchMCP – 多提供者聚合与结果去重

    pranavms13/web-search-mcp – 无头浏览器抓取思路

    tamb/simple-web-search-mcp – 零配置理念

🧩 MCP SDK 与示例

    @modelcontextprotocol/sdk – 项目基础

    Model Context Protocol 官方文档 – 协议设计依据

💡 其他灵感来源

    web-research-mcp – 无需 API 密钥、并行多查询

    lc-mcp-server – 模拟模式

    Tencent/WebSearchMCP – 企业级 MCP 服务实现

📌 开发者说明

    本 MCP 服务器的编译与开发过程中，得到了 DeepSeek 的辅助，但经过本人实际测试可正常运行。

    所有配置和代码均由 DeepSeek 协助完成，若在使用中发现缺陷，欢迎提交 Issue 或 Pull Request。

    如果您不信任此项目能力，可以选择不克隆使用，感谢您抽空阅读本 README。
更新日志：
2026/08/01经修复了已知问题

最后，感谢您下载并使用本项目！ 🎉

如果您觉得有用，欢迎 Star ⭐ 支持，让更多人受益。
