const serverless = require('serverless-http');
const app = require('../../server');

exports.handler = serverless(app, {
    binary: ['multipart/form-data', 'application/octet-stream', 'image/*', 'application/pdf']
});
