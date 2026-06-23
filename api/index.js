// Vercel Serverless Function 入口
// Vercel 会将 /api/* 的所有请求路由到此文件
// Express 收到的 req.url 是完整的原始路径（如 /api/terms）
// 所以 Express 路由 app.get('/api/terms', ...) 可以正常匹配
const app = require('../server.js');

// 确保在 Vercel 环境下 Express 能正确处理请求路径
// Vercel Serverless Function 中 req.url 包含完整路径
module.exports = app;