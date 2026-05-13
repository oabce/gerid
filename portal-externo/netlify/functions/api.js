const serverless = require('serverless-http');
const app = require('../../server');

const handler = serverless(app);

// Netlify remove o prefixo /api do path; adicionamos de volta para o Express
exports.handler = async (event, context) => {
    const modified = { ...event, path: '/api' + (event.path || '/') };
    return handler(modified, context);
};
