// Vercel Serverless Function 入口
// 将 Express app 导出为 Vercel handler
const app = require('../server.js');
module.exports = app;