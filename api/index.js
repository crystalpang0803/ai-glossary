// Vercel Serverless Function - API 入口
// 处理所有 /api/* 请求
const serverless = require('serverless-http');
const app = require('../server.js');

// 使用 serverless-http 包装 Express app
// vercel.json: source "/api/:match*" -> destination "/api/index"
// serverless-http 会正确处理 Vercel 的请求格式，保留路径和查询参数
module.exports = serverless(app);