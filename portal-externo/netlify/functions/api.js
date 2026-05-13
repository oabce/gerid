const serverless = require('serverless-http');
const app = require('../../server');

// event.path já contém o path original (/api/public/categorias, etc.)
exports.handler = serverless(app);
