// Vercel Serverless Function - API 入口
// 处理所有 /api/* 请求
const app = require('../server.js');

// Vercel 会将 rewrite 后的请求转发给此 handler
// vercel.json: source "/api/:match*" -> destination "/api/index"
// 注意：Vercel 会保留原始请求路径在 req.url 中，Express 可以正常路由
module.exports = app;