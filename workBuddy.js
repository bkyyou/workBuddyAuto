import { CODEBUDDY_API_KEY, CODEBUDDY_INTERNET_ENVIRONMENT } from './privateKey.js'
import { query } from '@tencent-ai/agent-sdk';

/**
 * 将可能被错误编码为 Latin-1 的 UTF-8 字符串修复回来
 */
function fixUtf8(str) {
  if (typeof str !== 'string') return str;
  try {
    const bytes = new Uint8Array(str.split('').map(c => c.charCodeAt(0) & 0xFF));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(bytes);
  } catch {
    return str;
  }
}

/**
 * 安全记录日志：先尝试修复乱码，再写入 logStore
 */
function safeLog(logStore, ...args) {
  const text = args.map(a => {
    if (typeof a === 'object') return JSON.stringify(a);
    return fixUtf8(String(a));
  }).join(' ');
  logStore.lines.push(text);
  console.log(text);
}

/**
 * @param {object} logStore - { isRunning, startTime, endTime, lines, result, error }
 */
async function workBuddy(logStore) {
  logStore.isRunning = true;
  logStore.startTime = Date.now();
  logStore.lines.length = 0;  // 清空但不替换数组引用（SSE 监听了 push）
  logStore.result = null;
  logStore.error = null;

  const log = (...args) => safeLog(logStore, ...args);

  try {
    log('[workBuddy] 开始执行 ci:dev...');

    const q = query({
      prompt: '请在 /Users/bikeyou/Desktop/yeqiao-mobile-copy/yeqiao-mobile 目录下执行 npm run ci:dev 命令。注意：这是前台命令，需要等待完成，不要后台运行。请确保每个步骤的完整输出都返回。',
      options: {
        cwd: '/Users/bikeyou/Desktop/yeqiao-mobile-copy/yeqiao-mobile',
        permissionMode: 'bypassPermissions',
        maxTurns: 20,
        env: {
          CODEBUDDY_API_KEY,
          CODEBUDDY_INTERNET_ENVIRONMENT,
          LANG: 'zh_CN.UTF-8',
          LC_ALL: 'zh_CN.UTF-8',
        }
      }
    });

    for await (const msg of q) {
      if (msg.type === 'result') {
        const status = msg.subtype === 'success' ? '成功' : '失败';
        log(`[workBuddy] 执行${status}，耗时: ${msg.duration_ms}ms`);
        logStore.result = { success: msg.subtype === 'success', durationMs: msg.duration_ms };
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            log(block.text);
          } else if (block.type === 'tool_use') {
            log(`[工具调用] ${block.name}`);
            if (block.input) log(`  参数: ${JSON.stringify(block.input).slice(0, 200)}`);
          } else if (block.type === 'tool_result') {
            // bash / 文件读取等工具的实际输出
            const content = typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content)
                  ? block.content.map(c => (c.text || '')).join('')
                  : JSON.stringify(block.content));
            if (content) {
              // 按行拆分，每行单独记录，便于前端展示
              content.split('\n').forEach(line => log(line));
            }
          } else {
            log(`[debug] 未知块类型: ${block.type} — ${JSON.stringify(block).slice(0, 300)}`);
          }
        }
      } else if (msg.type === 'user') {
        for (const block of (msg.message?.content || [])) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content)
                  ? block.content.map(c => (c.text || '')).join('')
                  : JSON.stringify(block.content));
            if (content) {
              content.split('\n').forEach(line => log(line));
            }
          }
        }
      } else if (msg.type === 'system') {
        // 系统消息（如 init、status、thinking 等）通常包含乱码，跳过或简要记录
        const text = msg.message?.content?.[0]?.text || JSON.stringify(msg).slice(0, 200);
        log(`[system] ${fixUtf8(text)}`);
      } else {
        // 兜底：打印未知消息类型，方便调试
        log(`[debug] 未知消息类型: ${msg.type} — ${JSON.stringify(msg).slice(0, 300)}`);
      }
    }
  } catch (err) {
    const errMsg = err.message || String(err);
    log(`[workBuddy] 执行失败: ${fixUtf8(errMsg)}`);
    logStore.error = errMsg;
  } finally {
    logStore.isRunning = false;
    logStore.endTime = Date.now();
  }
}

export default workBuddy;
