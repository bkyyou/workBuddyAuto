import Koa from 'koa';
import Router from '@koa/router';
import { EventEmitter } from 'events';
import workBuddy from './workBuddy.js'

const app = new Koa();
const router = new Router();

// 日志事件总线：每新增一行日志就 emit，供 SSE 订阅
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

// 全局日志存储：所有 workBuddy 的执行日志都存在这里
const logStore = {
  isRunning: false,
  startTime: null,
  endTime: null,
  lines: [],
  result: null,
  error: null,
};

// 包装 workBuddy，注入 logEmitter 使日志实时推送
function wrapLogStore(store) {
  const originalPush = store.lines.push.bind(store.lines);
  store.lines.push = function (line) {
    const result = originalPush(line);
    logEmitter.emit('line', line);
    return result;
  };
  return store;
}

// 触发构建（串行：同一时间只允许一个 build）
router.get('/build', async (ctx) => {
  if (logStore.isRunning) {
    ctx.status = 409;
    ctx.body = { code: 409, message: '已有构建任务正在执行中' };
    return;
  }

  // 立即返回 202，不等待 workBuddy 执行完成
  ctx.status = 202;
  ctx.body = { code: 202, message: '构建任务已接受，请通过 /log 获取进度' };

  // fire-and-forget：后台执行，不阻塞本次 HTTP 响应
  workBuddy(wrapLogStore(logStore)).catch(err => {
    logStore.error = err.message || String(err);
    logStore.isRunning = false;
    logStore.endTime = Date.now();
    console.error('[service] workBuddy 后台执行失败:', err);
  });
});

// GET 获取当前操作日志（快照/轮询用）
router.get('/log', async (ctx) => {
  ctx.body = {
    code: 200,
    data: {
      isRunning: logStore.isRunning,
      startTime: logStore.startTime,
      endTime: logStore.endTime,
      lines: logStore.lines,
      result: logStore.result,
      error: logStore.error,
    }
  };
});

// GET SSE 实时日志流（浏览器直接打开即可看到逐行输出）
router.get('/log/stream', async (ctx) => {
  ctx.set({
    // 'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // 禁用 nginx 缓冲
    'Content-Type': 'application/json; charset=utf-8',
  });
  ctx.status = 200;

  // 先推送已有的全部日志
  for (const line of logStore.lines) {
    ctx.res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }

  const onLine = (line) => {
    ctx.res.write(`data: ${JSON.stringify({ line })}\n\n`);
  };
  const onDone = (result, error) => {
    ctx.res.write(`data: ${JSON.stringify({ done: true, result, error })}\n\n`);
    ctx.res.end();
  };

  logEmitter.on('line', onLine);

  // 如果任务已结束，立即发送 done 事件
  if (!logStore.isRunning && logStore.startTime) {
    onDone(logStore.result, logStore.error);
    logEmitter.off('line', onLine);
    return;
  }

  // 监听结束事件
  const checkDone = setInterval(() => {
    if (!logStore.isRunning && logStore.startTime) {
      clearInterval(checkDone);
      onDone(logStore.result, logStore.error);
      logEmitter.off('line', onLine);
    }
  }, 500);

  ctx.req.on('close', () => {
    clearInterval(checkDone);
    logEmitter.off('line', onLine);
  });
});

// 定义一个带参数的 GET 接口（如获取用户信息）
router.get('/users/:id', async (ctx) => {
  const userId = ctx.params.id;
  ctx.body = {
    status: 200,
    message: '获取用户信息成功',
    data: { id: userId, name: '张三', age: 20 }
  };
});
// 定义一个带参数的 GET 接口（如获取用户信息）
router.get('/test', async (ctx) => {
  const userId = ctx.params.id;
  ctx.body = {
    status: 200,
    message: '获取用户信息成功',
    data: '111'
  };
});

// 将路由注册到 Koa 实例上
app.use(router.routes());
app.use(router.allowedMethods());

// 启动服务器
app.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on http://localhost:3000');
});