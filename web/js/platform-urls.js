/**
 * 平台搜索页地址（唯一真源在 relay/platform-urls.js）
 *
 * 之所以放在 relay/ 下：中继（Node）和前端（浏览器）都要用同一套地址，
 * 而 Node 不能 import 浏览器模块；反过来浏览器 import 一个纯函数模块没问题。
 * 所以真源放在中继那边，这里只做一次转出，避免两边各写一份、改一处漏一处。
 *
 * 这样 dist 里也能成立：dist/web/js/platform-urls.js -> dist/relay/platform-urls.js。
 */

export { PLATFORM_SEARCH, platformSearchUrl, PLATFORM_LABEL } from '../../relay/platform-urls.js';